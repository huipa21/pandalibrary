import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const timestamp = '2026-11-04T00:00:00Z';
const customShelf = {
	id: 11, kind: 'private', owner_id: 1, name: 'Weekend reads', description: 'Picked for weekends.',
	created_by: 1, visible_book_count: 0, created_at: timestamp, updated_at: timestamp,
	mode: 'manual', system_key: null
};

interface MockState {
	locale: 'en' | 'zh';
}

async function mockApi(page: Page, state: MockState) {
	const unexpected: string[] = [];
	const viewer = { id: 1, username: 'admin', display_name: 'Admin', role: 'admin', locale: state.locale };
	await page.route((url) => url.pathname.startsWith('/api/v1/'), (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname.replace('/api/v1', '');
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: { user: viewer } });
		if (path === '/version') return route.fulfill({ json: {
			version: 'test', commit: 'test', commit_date: timestamp, dirty: false, release: null
		} });
		if (path === '/sync/pull') return route.fulfill({ json: {
			cursor: 0, user_books: [], reading_progress: [], highlights: [], bookmarks: [], notes: [], user_settings: []
		} });
		if (path === '/me/settings') return route.fulfill({ json: { settings: [] } });
		if (path === '/me/profile') return route.fulfill({ json: { user: viewer } });
		if (path === '/me/app-passwords') return route.fulfill({ json: { app_passwords: [] } });
		if (path === '/me/notes') return route.fulfill({ json: { items: [], next_cursor: null, total: 0 } });
		if (path === '/admin/bookheap/items') return route.fulfill({ json: { items: [], next_cursor: null, total: 0 } });
		if (path === '/admin/bookheap/scan') return route.fulfill({ json: { scan: null } });
		if (path === '/shelves') return route.fulfill({ json: { items: [customShelf], next_cursor: null } });
		if (path === '/shelves/11') return route.fulfill({ json: { shelf: customShelf } });
		if (path === '/shelves/11/books') return route.fulfill({ json: { items: [], next_cursor: null } });
		if (path.startsWith('/shelves/system/')) {
			if (path.endsWith('/books')) return route.fulfill({ json: { items: [], next_cursor: null } });
			const key = path.split('/').at(-1);
			return route.fulfill({ json: { shelf: {
				...customShelf, id: key === 'favorites' ? 12 : 13, name: key, system_key: key,
				description: key === 'favorites' ? 'Books marked as favorites.' : null
			} } });
		}
		if (path === '/libraries/1') return route.fulfill({ json: { library: {
			id: 1, name: 'Fiction', slug: 'fiction', created_at: timestamp, updated_at: timestamp
		} } });
		if (path === '/books/count') return route.fulfill({ json: { count: 0 } });
		if (['/libraries', '/books', '/authors', '/series', '/tags'].includes(path) ||
			path.startsWith('/dashboard/sections/')) {
			return route.fulfill({ json: { items: [], next_cursor: null } });
		}
		if (path === '/stats') return route.fulfill({ json: {
			from: url.searchParams.get('from'), to: url.searchParams.get('to'),
			timezone: url.searchParams.get('timezone'), daily: [], finished_per_month: [],
			streaks: { current_days: 0, longest_days: 0 }, time_per_book: []
		} });
		unexpected.push(`${request.method()} ${path}`);
		return route.fulfill({ status: 404, json: { title: 'Unexpected request', status: 404 } });
	});
	return unexpected;
}

test('menu destinations keep accessible titles without repeated visible introductions', async ({ page }) => {
	test.setTimeout(90_000);
	const unexpected = await mockApi(page, { locale: 'en' });
	await page.setViewportSize({ width: 1600, height: 900 });
	const destinations = [
		{ path: '/', heading: 'Dashboard', description: 'Your books, arranged your way.' },
		{ path: '/books', heading: 'All Books', description: 'Every book you can access, across all of your libraries.' },
		{ path: '/bookheap', heading: 'Bookheap', description: 'Files waiting to be added to a library. Scan the server folder or upload files, then assign them to a library and shelves.' },
		{ path: '/notes', heading: 'Annotations', description: 'Browse your reviews, comments and reader annotations.' },
		{ path: '/shelves', heading: 'Collections', description: 'Organize books on your private shelves and browse shared shelves.' },
		{ path: '/shelves/11', heading: 'Weekend reads' },
		{ path: '/shelves/system/unshelved', heading: 'Unshelved' },
		{ path: '/shelves/system/favorites', heading: 'Favorites' },
		{ path: '/libraries', heading: 'Your libraries', description: 'Choose a library to browse its books.' },
		{ path: '/authors', heading: 'Authors' },
		{ path: '/series', heading: 'Series' },
		{ path: '/tags', heading: 'Tags' },
		{ path: '/read', heading: 'Choose a book to read', description: 'Choose an available format to open it in your browser.' },
		{ path: '/search', heading: 'Search', description: 'Find books by title, author, series, tag, or other details.' },
		{ path: '/stats', heading: 'Reading stats', description: 'See how much you read each day, which books you finished, and your reading streaks.' },
		{ path: '/admin', heading: 'Administration', description: 'Manage libraries, access, hidden books, imports, metadata providers, and maintenance for this server.' },
		{ path: '/settings', heading: 'Account settings', description: 'Manage your profile and device passwords.' }
	];
	for (const destination of destinations) {
		await page.goto(destination.path);
		const main = page.getByRole('main');
		const heading = main.getByRole('heading', { name: destination.heading, level: 1, exact: true });
		await expect(heading).toHaveClass('sr-only');
		if (destination.description) await expect(main.getByText(destination.description, { exact: true })).toHaveCount(0);
		if (destination.path === '/settings') {
			await page.getByRole('button', { name: 'Account menu', exact: true }).click();
			await expect(page.getByRole('menuitem', { name: 'Profile', exact: true }))
				.toHaveAttribute('aria-current', 'page');
		} else if (['/', '/bookheap', '/notes', '/shelves', '/shelves/11', '/shelves/system/favorites'].includes(destination.path)) {
			await expect(page.getByRole('navigation', { name: 'Main navigation' }).locator(`a[href="${destination.path}"]`))
				.toHaveAttribute('aria-current', 'page');
		} else {
			await expect(page.getByRole('navigation', { name: 'Main navigation' }).locator(`a[href="${destination.path}"]`)).toHaveCount(0);
		}
	}

	await page.goto('/books');
	await expect(page.getByRole('main').getByRole('heading', { name: 'Books', level: 2 })).toHaveClass('sr-only');
	await page.goto('/library/1');
	await expect(page.getByRole('main').getByRole('heading', { name: 'Fiction', level: 1 })).toBeVisible();
	await expect(page.getByRole('main').getByRole('heading', { name: 'Books', level: 2 })).toBeVisible();
	expect(unexpected).toEqual([]);
});

test('shelf descriptions remain available without showing introductory text by default', async ({ page }) => {
	const unexpected = await mockApi(page, { locale: 'en' });
	await page.goto('/shelves/11');
	await expect(page.getByText('Picked for weekends.')).toBeHidden();
	await page.getByText('Collection details', { exact: true }).click();
	await expect(page.getByText('Picked for weekends.')).toBeVisible();
	await page.goto('/shelves/system/favorites');
	await expect(page.getByText('Books marked as favorites.')).toBeHidden();
	await page.getByText('Collection details', { exact: true }).click();
	await expect(page.getByText('Books marked as favorites.')).toBeVisible();
	expect(unexpected).toEqual([]);
});

async function expectGreenFocus(control: Locator) {
	await control.focus();
	await expect(control).toBeFocused();
	await expect(control).toHaveCSS('outline-style', 'solid');
	await expect(control).toHaveCSS('outline-width', '2px');
	await expect(control).toHaveCSS('outline-offset', '-2px');
	const style = await control.evaluate((element) => {
		const computed = getComputedStyle(element);
		const probe = document.createElement('span');
		probe.style.color = 'var(--color-shell-accent)';
		element.after(probe);
		const green = getComputedStyle(probe).color;
		probe.remove();
		const rect = element.getBoundingClientRect();
		// The sticky header band must not paint over the top edge of the ring.
		const coveredBy = [rect.left + 3, rect.left + rect.width / 2, rect.right - 3]
			.map((x) => document.elementFromPoint(x, rect.top + 1))
			.filter((hit) => hit !== element)
			.map((hit) => hit?.tagName ?? 'none');
		const clippedBy: string[] = [];
		for (let parent = element.parentElement; parent; parent = parent.parentElement) {
			const bounds = parent.getBoundingClientRect();
			const parentStyle = getComputedStyle(parent);
			if (/(hidden|clip|auto|scroll)/.test(parentStyle.overflowX) &&
				(rect.left - 4 < bounds.left || rect.right + 4 > bounds.right)) {
				clippedBy.push(parent.tagName);
			}
			if (/(hidden|clip|auto|scroll)/.test(parentStyle.overflowY) &&
				(rect.top - 4 < bounds.top || rect.bottom + 4 > bounds.bottom)) {
				clippedBy.push(parent.tagName);
			}
		}
		return { color: computed.outlineColor, green, height: rect.height,
			radius: computed.borderRadius, border: computed.borderWidth, clippedBy, coveredBy };
	});
	expect(style.color).toBe(style.green);
	expect(style.height).toBe(36);
	expect(style.radius).toBe('6px');
	expect(style.border).toBe('1px');
	expect(style.clippedBy).toEqual([]);
	expect(style.coveredBy).toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
	for (const width of [375, 1440]) {
		test(`search and filter controls have complete green focus outlines in ${theme} at ${width}px`, async ({ page }) => {
			const unexpected = await mockApi(page, { locale: 'en' });
			await page.setViewportSize({ width, height: 900 });
			await page.emulateMedia({ colorScheme: theme });
			await page.goto('/bookheap');
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			const main = page.getByRole('main');
			const status = main.getByRole('combobox', { name: 'Status', exact: true });
			await expect(status).toBeVisible();
			await expect(main.getByText('Status', { exact: true })).toHaveCount(0);
			await expectGreenFocus(status);
			await expectGreenFocus(main.getByRole('searchbox', { name: 'Search', exact: true }));
			await status.selectOption('ready');
			await expect(page).toHaveURL(/status=ready/);

			await page.goto('/notes');
			const type = main.getByRole('combobox', { name: 'Annotation type' });
			const search = main.getByRole('searchbox', { name: 'Search annotations', exact: true });
			await expectGreenFocus(type);
			await type.press('Tab');
			await expect(search).toBeFocused();
			await expectGreenFocus(search);
			const dropdownBounds = await type.boundingBox();
			const searchBounds = await search.boundingBox();
			expect(dropdownBounds).not.toBeNull();
			expect(searchBounds).not.toBeNull();
			if (dropdownBounds && searchBounds) {
				expect(searchBounds.x >= dropdownBounds.x + dropdownBounds.width + 8 ||
					searchBounds.y >= dropdownBounds.y + dropdownBounds.height + 8).toBe(true);
			}
			await type.selectOption('review');
			await expect(page).toHaveURL(/kind=review/);

			await page.goto('/books');
			const filters = main.getByRole('combobox');
			await expect(filters).toHaveCount(4);
			for (const filter of await filters.all()) await expectGreenFocus(filter);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
			expect(unexpected).toEqual([]);
		});
	}
}

for (const locale of ['en', 'zh'] as const) {
	test(`retired ${locale} bookmarks links redirect to the book list`, async ({ page }) => {
		const unexpected = await mockApi(page, { locale });
		await page.goto(locale === 'zh' ? '/zh/bookmarks' : '/bookmarks');
		await expect(page).toHaveURL(/\/(?:zh\/)?books$/);
		await expect(page.getByRole('main').getByRole('heading', {
			name: locale === 'zh' ? '全部图书' : 'All Books', level: 1, exact: true
		})).toHaveClass('sr-only');
		expect(unexpected).toEqual([]);
	});
}
