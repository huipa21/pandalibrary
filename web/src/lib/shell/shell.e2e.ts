import { expect, test, type Page } from '@playwright/test';

async function authenticate(page: Page, role = 'user', locale = 'en') {
	await page.route('**/api/v1/me/book-states?*', (route) => route.fulfill({ json: { items: [] } }));
	await page.route('**/api/v1/sync/pull?*', (route) => route.fulfill({ json: {
		cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: []
	} }));
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) =>
		route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role, locale } } })
	);
	await page.route('**/api/v1/shelves?*', (route) => route.fulfill({ json: {
		items: [{
			id: 7, kind: 'private', owner_id: 1, name: 'Weekend reads', description: null, created_by: 1,
			visible_book_count: 3, created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z'
		}],
		next_cursor: null
	} }));
	for (const [key, id] of [['unshelved', 8], ['favorites', 9]] as const) {
		await page.route(`**/api/v1/shelves/system/${key}`, (route) => route.fulfill({ json: { shelf: {
			id, kind: 'private', mode: 'system', system_key: key, owner_id: 1, name: key,
			description: null, created_by: 1, visible_book_count: 0,
			created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z'
		} } }));
	}
	await page.route('**/api/v1/libraries?*', (route) => route.fulfill({ json: {
		items: [{ id: 1, name: 'Fiction', slug: 'fiction', created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z' }],
		next_cursor: null
	} }));
}

const book = {
	id: 21, library_id: 1, title: 'A Book', sort_title: 'A Book', subtitle: null, description: null,
	language: null, publisher: null, published_date: null, page_count: null, cover_url: null, cover_source: null,
	authors: [{ id: 4, name: 'A Writer', role: 'author', position: 0 }], series: null, tags: [],
	identifiers: [], files: [], field_sources: [],
	created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z'
};

async function mockCatalog(page: Page) {
	const bookQueries: URLSearchParams[] = [];
	await page.route('**/api/v1/books?*', (route) => {
		bookQueries.push(new URL(route.request().url()).searchParams);
		return route.fulfill({ json: { items: [book], next_cursor: null } });
	});
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book } }));
	for (const kind of ['authors', 'series', 'tags']) {
		await page.route(`**/api/v1/${kind}?*`, (route) => route.fulfill({ json: {
			items: kind === 'authors' ? [{ id: 4, name: 'A Writer', visible_book_count: 1 }] : [], next_cursor: null
		} }));
	}
	return bookQueries;
}

async function expectNoHorizontalOverflow(page: Page) {
	const widths = await page.evaluate(() => ({
		viewport: document.documentElement.clientWidth,
		content: document.documentElement.scrollWidth
	}));
	expect(widths.content).toBeLessThanOrEqual(widths.viewport);
}

function contrastRatio(foreground: string, background: string): number {
	const luminance = (color: string) => {
		const channels = color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number);
		if (!channels || channels.length !== 3) throw new Error(`Unexpected computed color: ${color}`);
		const [red, green, blue] = channels.map((channel) => {
			const value = channel / 255;
			return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
	};
	const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
	return (values[0] + 0.05) / (values[1] + 0.05);
}

test('desktop sidebar lists HOME links, shelves, and All Books across every library', async ({ page }) => {
	await authenticate(page);
	const bookQueries = await mockCatalog(page);
	await page.setViewportSize({ width: 1280, height: 800 });

	await page.goto('/books?author_id=4&sort=added');
	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	await expect(sidebar).toBeVisible();
	await expect(page.getByRole('button', { name: 'Open navigation menu' })).toBeHidden();
	const home = sidebar.getByRole('region', { name: 'Home' }).getByRole('link');
	await expect(home).toHaveText(['Dashboard', 'All Books', 'Bookmarks', 'Notes']);
	await expect(sidebar.getByRole('link', { name: 'All Books' })).toHaveAttribute('aria-current', 'page');
	await expect(sidebar.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current', 'page');
	await expect(sidebar.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
	for (const name of ['Libraries', 'Authors', 'Series', 'Tags', 'Read', 'Search', 'Stats']) {
		await expect(sidebar.getByRole('link', { name, exact: true })).toBeVisible();
	}

	const shelves = sidebar.getByRole('region', { name: 'Shelves' });
	await expect(shelves.getByRole('link', { name: /Weekend reads/ })).toHaveAttribute('href', '/shelves/7');
	await expect(shelves.getByRole('button', { name: 'New shelf' })).toBeVisible();
	await expect(shelves.getByRole('link', { name: /Favorites/ })).toHaveCount(1);
	await expect(page.locator('[data-slot="sidebar-footer"]')).toBeVisible();

	await expect(page.getByRole('heading', { name: 'All Books', level: 1 })).toHaveClass('sr-only');
	await expect(page.getByTitle('A Book', { exact: true })).toBeVisible();
	await expect(page.getByLabel('Author')).toHaveValue('4');
	expect(bookQueries[0].has('library_id')).toBe(false);
	expect(bookQueries[0].get('author_id')).toBe('4');
	expect(bookQueries[0].get('sort')).toBe('added');
	await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
	const account = page.getByRole('button', { name: 'Account menu' });
	await expect(account).toBeVisible();
	await account.click();
	await expect(page.getByRole('menuitem', { name: 'Profile' })).toBeVisible();
	await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(account).toBeFocused();
	await expectNoHorizontalOverflow(page);

	const box = await page.locator('#app-sidebar').boundingBox();
	expect(box?.width).toBeGreaterThanOrEqual(240);
	expect(box?.width).toBeLessThanOrEqual(260);
	const main = await page.locator('#main-content').boundingBox();
	expect(main?.width).toBeGreaterThan(900);

	await page.getByTitle('A Book', { exact: true }).click({ position: { x: 10, y: 40 } });
	await expect(page).toHaveURL('/books/21');
	await expect(sidebar.getByRole('link', { name: 'All Books' })).not.toHaveAttribute('aria-current', 'page');

	await sidebar.getByRole('link', { name: 'Libraries', exact: true }).click();
	await expect(page).toHaveURL('/libraries');
	await expect(page.getByRole('link', { name: 'Fiction' })).toHaveAttribute('href', '/library/1');
	await expect(sidebar.getByRole('link', { name: 'Libraries', exact: true })).toHaveAttribute('aria-current', 'page');

	await sidebar.getByRole('link', { name: 'Dashboard' }).click();
	await expect(page).toHaveURL('/');
	await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toHaveClass('sr-only');
});

test('administrators see the Admin entry with localized Chinese navigation', async ({ page }) => {
	await authenticate(page, 'admin', 'zh');
	await page.goto('/');
	const sidebar = page.getByRole('navigation', { name: '主导航' });
	await expect(sidebar.getByRole('region', { name: '主页' }).getByRole('link')).toHaveText(['仪表盘', '全部图书', /^书堆/, '书签', '笔记']);
	await expect(sidebar.getByRole('link', { name: /^书堆/ })).toHaveAttribute('href', '/bookheap');
	await expect(sidebar.getByRole('link', { name: '管理', exact: true })).toHaveAttribute('href', '/admin');
	await expect(sidebar.getByRole('button', { name: '新建书架' })).toBeVisible();
	await expect(sidebar.getByRole('link', { name: '仪表盘' })).toHaveAttribute('aria-current', 'page');
});

test('keeps the mobile search and upload controls separate and usable', async ({ page }) => {
	await authenticate(page, 'admin');
	await mockCatalog(page);
	await page.setViewportSize({ width: 360, height: 844 });
	await page.goto('/books');
	const header = page.getByRole('banner');
	const search = header.getByRole('searchbox', { name: 'Search books' });
	const submit = header.getByRole('button', { name: 'Search', exact: true });
	const upload = header.getByRole('button', { name: 'Upload', exact: true });
	for (const width of [320, 360, 768]) {
		await page.setViewportSize({ width, height: 844 });
		const [inputBox, submitBox, uploadBox] = await Promise.all([
			search.boundingBox(), submit.boundingBox(), upload.boundingBox()
		]);
		if (!inputBox || !submitBox || !uploadBox) throw new Error('A header control is not visible');
		expect(inputBox.width).toBeGreaterThanOrEqual(64);
		expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(submitBox.x);
		expect(submitBox.x + submitBox.width).toBeLessThanOrEqual(uploadBox.x);
		await expectNoHorizontalOverflow(page);
	}
	await search.fill('panda');
	await submit.click();
	await expect(page).toHaveURL('/search?q=panda');
});

test('mobile drawer toggles by keyboard, traps focus, closes on Escape and navigation', async ({ page }) => {
	await authenticate(page);
	await mockCatalog(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toHaveClass('sr-only');

	const toggle = page.getByRole('button', { name: 'Open navigation menu' });
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeHidden();
	await expectNoHorizontalOverflow(page);

	await toggle.focus();
	await page.keyboard.press('Enter');
	const close = page.getByRole('button', { name: 'Close navigation menu' });
	await expect(close).toHaveAttribute('aria-expanded', 'true');
	const drawer = page.getByRole('dialog', { name: 'Sidebar' });
	await expect(drawer).toBeVisible();
	await expect(drawer.getByRole('link', { name: 'Dashboard' })).toBeFocused();
	await expect(drawer.getByRole('button', { name: 'Language' })).toBeVisible();
	await expect(drawer.getByRole('button', { name: 'Switch to dark mode' })).toBeVisible();
	const drawerLanguage = drawer.getByRole('button', { name: 'Language' });
	await drawerLanguage.click();
	const languageDialog = page.getByRole('dialog', { name: 'Language' });
	await expect(languageDialog.getByRole('searchbox', { name: 'Search languages' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(drawerLanguage).toBeFocused();
	await expect(drawer).toBeVisible();
	await drawer.getByRole('link', { name: 'Dashboard' }).focus();

	await page.keyboard.press('Shift+Tab');
	await expect(close).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(drawer.locator(':focus')).toHaveCount(1);
	await expectNoHorizontalOverflow(page);

	await page.keyboard.press('Escape');
	await expect(drawer).toBeHidden();
	await expect(toggle).toBeFocused();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');

	await toggle.click();
	await page.getByRole('dialog', { name: 'Sidebar' }).getByRole('link', { name: 'All Books' }).click();
	await expect(page).toHaveURL('/books');
	await expect(page.getByRole('dialog', { name: 'Sidebar' })).toBeHidden();
	await expect(page.getByTitle('A Book', { exact: true })).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('public pages keep language and theme controls without the sidebar', async ({ page }) => {
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) => route.fulfill({
		status: 401, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Unauthorized', status: 401 })
	}));
	await page.goto('/books');
	await expect(page).toHaveURL('/login');
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Language' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Switch to dark mode' })).toBeVisible();
	await expect(page.locator('#app-sidebar')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Open navigation menu' })).toHaveCount(0);
});

test('header controls keep their order and responsive visibility', async ({ page }) => {
	await authenticate(page, 'admin');
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/books');
	const header = page.getByRole('banner');
	const orderedControls = [
		header.getByRole('searchbox', { name: 'Search books' }),
		header.getByRole('button', { name: 'Search', exact: true }),
		header.getByRole('button', { name: 'Upload' }),
		header.getByRole('button', { name: 'Language' }),
		header.getByRole('button', { name: 'Switch to dark mode' }),
		header.getByRole('button', { name: 'Account menu' })
	];
	const positions = await Promise.all(orderedControls.map(async (control) => (await control.boundingBox())?.x));
	expect(positions.every((position) => position !== undefined)).toBe(true);
	expect(positions).toEqual([...positions].sort((a, b) => a! - b!));

	for (const width of [768, 360, 320]) {
		await page.setViewportSize({ width, height: 844 });
		await expect(header.getByRole('button', { name: 'Account menu' })).toBeVisible();
		await expect(header.getByRole('button', { name: 'Upload' })).toBeVisible();
		if (width < 640) {
			await expect(header.getByRole('button', { name: 'Language' })).toBeHidden();
			await expect(header.getByRole('button', { name: 'Switch to dark mode' })).toBeHidden();
		} else {
			await expect(header.getByRole('button', { name: 'Language' })).toBeVisible();
			await expect(header.getByRole('button', { name: 'Switch to dark mode' })).toBeVisible();
		}
		await expectNoHorizontalOverflow(page);
	}
});

test('language selection persists through the profile API and shows local-only fallback', async ({ page }) => {
	let selectedLocale = 'en';
	await authenticate(page);
	await page.route('**/api/v1/auth/me', (route) =>
		route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: selectedLocale } } })
	);
	let profileBody: unknown;
	await page.route('**/api/v1/me/profile', async (route) => {
		profileBody = route.request().postDataJSON();
		selectedLocale = (profileBody as { locale: string }).locale;
		await route.fulfill({ json: { user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: selectedLocale } } });
	});
	await page.goto('/');
	await page.getByRole('button', { name: 'Language' }).click();
	await expect(page.getByRole('dialog', { name: 'Language' })).toBeVisible();
	const search = page.getByRole('searchbox', { name: 'Search languages' });
	await expect(search).toBeFocused();
	await search.fill('简体中文');
	const chinese = page.getByRole('option', { name: /简体中文/ });
	await search.press('ArrowDown');
	await expect(chinese).toBeFocused();
	await page.keyboard.press('Enter');
	await expect.poll(() => profileBody).toEqual({ display_name: 'Reader', locale: 'zh' });
	await expect(page.locator('html')).toHaveAttribute('lang', 'zh');

	await page.route('**/api/v1/me/profile', (route) =>
		route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Unavailable', status: 503 }) })
	);
	await page.getByRole('button', { name: '语言' }).click();
	await page.getByRole('searchbox', { name: '搜索语言' }).fill('English');
	await page.getByRole('option', { name: /English/ }).last().click();
	const localOnlyNotice = page.getByText('Language changed on this device only', { exact: true });
	await expect(localOnlyNotice).toHaveAttribute('role', 'status');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await expect(page.getByText('Language changed on this device only', { exact: true })).toHaveCount(0);
});

test('signed-out language selection updates the login page', async ({ page }) => {
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) => route.fulfill({
		status: 401, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Unauthorized', status: 401 })
	}));
	await page.goto('/login');
	await page.getByRole('button', { name: 'Language' }).click();
	await page.getByRole('searchbox', { name: 'Search languages' }).fill('简体中文');
	await page.getByRole('option', { name: /简体中文/ }).click();
	await expect(page.locator('html')).toHaveAttribute('lang', 'zh');
	await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
});

test('theme choice persists and avatar menu supports keyboard navigation', async ({ page }) => {
	await authenticate(page);
	await page.emulateMedia({ colorScheme: 'light' });
	await page.goto('/');
	const theme = page.getByRole('button', { name: 'Switch to dark mode' });
	const panel = page.locator('.app-panel');
	const lightPanelColor = await panel.evaluate((element) => getComputedStyle(element).backgroundColor);
	await theme.focus();
	await page.keyboard.press('Space');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
	const darkPanelColor = await panel.evaluate((element) => getComputedStyle(element).backgroundColor);
	expect(darkPanelColor).not.toBe(lightPanelColor);
	const mutedColors = await panel.evaluate((element) =>
		['text-slate-400', 'text-slate-500'].map((className) => {
			const sample = document.createElement('span');
			sample.className = className;
			element.append(sample);
			const colors = { foreground: getComputedStyle(sample).color, background: getComputedStyle(element).backgroundColor };
			sample.remove();
			return colors;
		})
	);
	for (const colors of mutedColors) {
		expect(contrastRatio(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5);
	}
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

	const account = page.getByRole('button', { name: 'Account menu' });
	await account.focus();
	await page.keyboard.press('Enter');
	const profile = page.getByRole('menuitem', { name: 'Profile' });
	const signOut = page.getByRole('menuitem', { name: 'Sign out' });
	await expect(profile).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(signOut).toBeFocused();
	await page.keyboard.press('Home');
	await expect(profile).toBeFocused();
	await page.keyboard.press('End');
	await expect(signOut).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(account).toBeFocused();
});
