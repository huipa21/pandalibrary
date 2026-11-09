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

test('header and sidebar float as matching panels, content cards sit on an invisible area and scroll under an opaque header band', async ({ page }) => {
	await authenticate(page);
	await mockCatalog(page);
	await page.emulateMedia({ colorScheme: 'light' });
	await page.goto('/books');
	await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();

	for (const theme of ['light', 'dark']) {
		if (theme === 'dark') await page.getByRole('button', { name: 'Switch to dark mode' }).click();
		for (const width of [1024, 1280, 1600]) {
			await page.setViewportSize({ width, height: 900 });
			const metrics = await page.evaluate(() => {
				const measure = (selector: string) => {
					const element = document.querySelector(selector);
					if (!(element instanceof HTMLElement)) throw new Error(`Missing panel: ${selector}`);
					const box = element.getBoundingClientRect();
					const style = getComputedStyle(element);
					return {
						left: box.left, right: box.right, top: box.top, bottom: box.bottom,
						radius: style.borderTopLeftRadius,
						borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
						shadow: style.boxShadow,
						background: style.backgroundColor
					};
				};
				const body = document.querySelector('.shell-body');
				if (!(body instanceof HTMLElement)) throw new Error('The shell body is missing');
				return {
					gap: parseFloat(getComputedStyle(body).gap),
					pageBackground: getComputedStyle(document.querySelector('.app-shell')!).backgroundColor,
					band: measure('.shell-header-band'),
					header: measure('.shell-header'),
					sidebar: measure('#app-sidebar'),
					panel: measure('#main-content > div')
				};
			});
			expect(metrics.header.left).toBe(metrics.gap);
			expect(metrics.header.top).toBe(metrics.gap);
			expect(metrics.header.right).toBe(width - metrics.gap);
			expect(metrics.sidebar.left).toBe(metrics.header.left);
			expect(metrics.sidebar.top - metrics.header.bottom).toBe(metrics.gap);
			expect(metrics.band.bottom).toBe(metrics.sidebar.top);
			expect(metrics.band.background).toBe(metrics.pageBackground);
			expect(metrics.panel.top).toBe(metrics.sidebar.top);
			expect(metrics.panel.left - metrics.sidebar.right).toBe(metrics.gap);
			expect(metrics.panel.right).toBe(metrics.header.right);
			expect(metrics.sidebar.bottom).toBe(900 - metrics.gap);
			expect(metrics.panel.background).toBe('rgba(0, 0, 0, 0)');
			expect(metrics.panel.borders).toEqual(['0px', '0px', '0px', '0px']);
			expect(metrics.panel.shadow).toBe('none');
			expect(metrics.sidebar.radius).toBe(metrics.header.radius);
			for (const panel of [metrics.header, metrics.sidebar]) {
				expect(panel.borders).toEqual(['1px', '1px', '1px', '1px']);
				expect(panel.shadow).not.toBe('none');
			}
			await expectNoHorizontalOverflow(page);
		}
	}

	await page.locator('#main-content > div').evaluate((panel) => {
		const spacer = document.createElement('div');
		spacer.style.height = '2000px';
		panel.append(spacer);
	});
	await page.evaluate(() => window.scrollTo(0, 600));
	await expect(page.locator('.shell-header-band')).toHaveCSS('top', '0px');
	const [band, header, sidebar] = await Promise.all([
		page.locator('.shell-header-band').boundingBox(),
		page.getByRole('banner').boundingBox(),
		page.locator('#app-sidebar').boundingBox()
	]);
	if (!band || !header || !sidebar) throw new Error('A sticky panel is missing');
	expect(band.y).toBe(0);
	expect(band.y + band.height).toBe(sidebar.y);
	expect(header.y).toBe(20);
	expect(sidebar.y).toBe(header.y + header.height + 20);
	expect(sidebar.y + sidebar.height).toBe(880);

	await page.goto('/books/21');
	const tabs = page.getByRole('navigation', { name: 'Book sections' });
	await expect(tabs).toBeVisible();
	await tabs.evaluate((nav) => {
		const content = nav.parentElement?.parentElement;
		if (!content) throw new Error('The book tabs container is missing');
		const spacer = document.createElement('div');
		spacer.style.height = '2000px';
		content.append(spacer);
	});
	await page.evaluate(() => window.scrollTo(0, 600));
	await expect(tabs.locator('..')).toHaveCSS('top', '96px');
	const tabsBox = await tabs.locator('..').boundingBox();
	if (!tabsBox) throw new Error('The sticky book tabs are missing');
	expect(tabsBox.y).toBe(96);
	expect(tabsBox.y).toBe(band.y + band.height);
});

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
	for (const name of ['Libraries', 'Authors', 'Series', 'Tags', 'Read', 'Stats']) {
		await expect(sidebar.getByRole('link', { name, exact: true })).toBeVisible();
	}
	await expect(sidebar.getByRole('link', { name: 'Search', exact: true })).toHaveCount(0);

	const shelves = sidebar.getByRole('region', { name: 'Shelves' });
	await expect(shelves.getByRole('link', { name: /Weekend reads/ })).toHaveAttribute('href', '/shelves/7');
	const shelfActions = shelves.getByRole('button', { name: 'Shelf actions' });
	await expect(shelfActions).toBeVisible();
	await shelfActions.click();
	await expect(shelves.getByRole('menuitem', { name: 'New shelf' })).toBeVisible();
	await expect(shelves.getByRole('menuitem', { name: 'Manage shelves' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(shelfActions).toBeFocused();
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
	await sidebar.getByRole('button', { name: '书架操作' }).click();
	await expect(sidebar.getByRole('menuitem', { name: '新建书架' })).toBeVisible();
	await expect(sidebar.getByRole('menuitem', { name: '管理书架' })).toBeVisible();
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
	const [headerBox, drawerBox] = await Promise.all([
		page.getByRole('banner').boundingBox(), drawer.boundingBox()
	]);
	if (!headerBox || !drawerBox) throw new Error('A mobile shell panel is missing');
	expect(headerBox.x).toBe(8);
	expect(drawerBox.x).toBe(headerBox.x);
	expect(drawerBox.y).toBe(headerBox.y + headerBox.height + 8);
	expect(drawerBox.y + drawerBox.height).toBe(836);
	await expect(drawer).toHaveCSS('border-radius', '16px');
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
	await Promise.all(orderedControls.map((control) => expect(control).toBeVisible()));
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
	const surfaces = () => panel.evaluate((element) => {
		const card = document.createElement('div');
		card.className = 'card';
		element.append(card);
		const shell = document.querySelector('.app-shell');
		if (!shell) throw new Error('The app shell is missing');
		const colors = { page: getComputedStyle(shell).backgroundColor, card: getComputedStyle(card).backgroundColor };
		const muted = ['text-slate-400', 'text-slate-500'].map((className) => {
			const sample = document.createElement('span');
			sample.className = className;
			card.append(sample);
			const color = getComputedStyle(sample).color;
			sample.remove();
			return color;
		});
		card.remove();
		return { ...colors, muted };
	});
	const light = await surfaces();
	expect(light.card).not.toBe(light.page);
	expect(contrastRatio(light.muted[1], light.page)).toBeGreaterThanOrEqual(4.5);
	await theme.focus();
	await page.keyboard.press('Space');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
	const dark = await surfaces();
	expect(dark.page).not.toBe(light.page);
	// Cards must read as raised: lighter than the page in dark mode, not darker.
	expect(contrastRatio('rgb(0, 0, 0)', dark.card)).toBeGreaterThan(contrastRatio('rgb(0, 0, 0)', dark.page));
	for (const color of dark.muted) {
		expect(contrastRatio(color, dark.card)).toBeGreaterThanOrEqual(4.5);
		expect(contrastRatio(color, dark.page)).toBeGreaterThanOrEqual(4.5);
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

test('header brand uses the favicon and weight feedback without shifting', async ({ page }) => {
	await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
	await authenticate(page, 'admin');
	await mockCatalog(page);
	await page.route('**/api/v1/books/count', (route) => route.fulfill({ json: { count: 1 } }));
	await page.route('**/api/v1/admin/bookheap/items?*', (route) =>
		route.fulfill({ json: { items: [], total: 0, next_cursor: null } })
	);
	await page.route('**/api/v1/version', (route) => route.fulfill({ json: {
		version: 'test', commit: 'test', commit_date: '2026-11-09T00:00:00Z', dirty: false, release: null
	} }));
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/books');
	await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();

	const brand = page.getByRole('banner').getByRole('link', { name: 'PandaLibrary', exact: true });
	const logo = brand.locator('img');
	const text = brand.locator('.shell-brand-text');
	const width = () => brand.evaluate((element) => element.getBoundingClientRect().width);
	const expectActive = async (color: string) => {
		await expect(brand).toHaveCSS('text-decoration-line', 'none');
		await expect(text).toHaveCSS('text-decoration-line', 'none');
		await expect(text).toHaveCSS('font-weight', '700');
		await expect(text).toHaveCSS('color', color);
	};

	await brand.hover();
	await expect(brand).toHaveCSS('text-decoration-line', 'none');
	await page.mouse.move(0, 0);
	await expect(brand).toHaveAttribute('href', '/');
	await expect(brand).toHaveCSS('font-size', '14px');
	await expect(logo).toHaveAttribute('src', '/panda-icon.svg');
	await expect(logo).toHaveAttribute('alt', '');
	await expect(logo).toHaveAttribute('width', '28');
	await expect(logo).toHaveAttribute('height', '28');
	await expect.poll(() => logo.evaluate((element) =>
		element instanceof HTMLImageElement ? element.naturalWidth : 0
	)).toBeGreaterThan(0);
	await expect(logo).not.toHaveCSS('box-shadow', 'none');
	await expect(text).toHaveAttribute('data-text', 'PandaLibrary');
	const imageUrl = await logo.evaluate((element) => {
		if (!(element instanceof HTMLImageElement)) throw new Error('The brand logo is not an image');
		return element.src;
	});
	await expect(page.locator('head link[rel="icon"]')).toHaveJSProperty('href', imageUrl);
	await page.evaluate(async () => { await document.fonts.ready; });

	const themes = [
		{ name: 'light', active: 'rgb(4, 120, 87)' },
		{ name: 'dark', active: 'rgb(167, 243, 208)' }
	] as const;
	for (const theme of themes) {
		if (theme.name === 'dark') await page.getByRole('button', { name: 'Switch to dark mode' }).click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', theme.name);
		await page.mouse.move(0, 0);
		await expect(text).toHaveCSS('font-weight', '600');
		const originalWidth = await width();
		await brand.hover();
		await expectActive(theme.active);
		await expect(logo).toHaveCSS('transform', 'matrix(1.06, 0, 0, 1.06, 0, 0)');
		expect(await width()).toBe(originalWidth);

		await page.mouse.move(0, 0);
		await expect(text).toHaveCSS('font-weight', '600');
		await expect(logo).toHaveCSS('transform', 'none');
		await page.getByRole('link', { name: 'Skip to main content' }).focus();
		await page.keyboard.press('Tab');
		await expect(brand).toBeFocused();
		await expectActive(theme.active);
		await expect(logo).toHaveCSS('transform', 'matrix(1.06, 0, 0, 1.06, 0, 0)');
		await expect(brand).toHaveCSS('outline-style', 'solid');
		await expect(brand).toHaveCSS('outline-width', '2px');
		await expect(brand).toHaveCSS('outline-color', 'rgb(52, 211, 153)');
		await expect(brand).toHaveCSS('outline-offset', '2px');
		expect(await width()).toBe(originalWidth);
	}

	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(logo).toHaveCSS('transition-duration', '0s');
	await expect(logo).toHaveCSS('transform', 'none');
	await expectActive(themes[1].active);
	await page.getByRole('searchbox', { name: 'Search books' }).focus();
	await brand.hover();
	await expect(logo).toHaveCSS('transform', 'none');

	for (const viewportWidth of [320, 360, 1440]) {
		await page.setViewportSize({ width: viewportWidth, height: 844 });
		await expect(brand).toHaveAccessibleName('PandaLibrary');
		if (viewportWidth < 640) await expect(text).toBeHidden();
		else await expect(text).toBeVisible();
		await expect(logo).toBeVisible();
		await expectNoHorizontalOverflow(page);
	}

	await page.route('**/api/v1/auth/me', (route) => route.fulfill({
		status: 401, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Unauthorized', status: 401 })
	}));
	for (const publicPage of [
		{ path: '/login', required: false, heading: 'Sign in' },
		{ path: '/setup', required: true, heading: 'Set up PandaLibrary' }
	]) {
		await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: publicPage.required } }));
		await page.goto(publicPage.path);
		await expect(page.getByRole('heading', { name: publicPage.heading })).toBeVisible();
		for (const theme of themes) {
			if (await page.locator('html').getAttribute('data-theme') !== theme.name) {
				await page.getByRole('button', { name: `Switch to ${theme.name} mode` }).click();
			}
			for (const viewportWidth of [320, 360, 1440]) {
				await page.setViewportSize({ width: viewportWidth, height: 844 });
				await expect(brand).toHaveAccessibleName('PandaLibrary');
				await expect(text).toBeVisible();
				await expectNoHorizontalOverflow(page);
			}
			await page.setViewportSize({ width: 320, height: 844 });
			await page.mouse.move(0, 0);
			const originalWidth = await width();
			await brand.hover();
			await expectActive(theme.active);
			expect(await width()).toBe(originalWidth);
			await page.mouse.move(0, 0);
			await page.getByRole('link', { name: 'Skip to main content' }).focus();
			await page.keyboard.press('Tab');
			await expect(brand).toBeFocused();
			await expectActive(theme.active);
			expect(await width()).toBe(originalWidth);
		}
	}
});
