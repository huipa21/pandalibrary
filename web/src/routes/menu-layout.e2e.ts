import { expect, test, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const timestamp = '2026-11-04T00:00:00Z';
const bookmark = {
	id: 'bookmark-1', book_id: 21, book_file_id: 31, locator: { type: 'cfi', value: 'epubcfi(/6/2)' },
	position: 0.25, label: 'Saved page one', chapter: null, created_at: timestamp, updated_at: timestamp,
	deleted_at: null, rev: 1, book: { id: 21, title: 'A Book', cover_url: null }
};
const customShelf = {
	id: 11, kind: 'private', owner_id: 1, name: 'Weekend reads', description: 'Picked for weekends.',
	created_by: 1, visible_book_count: 0, created_at: timestamp, updated_at: timestamp,
	mode: 'manual', system_key: null
};

interface MockState {
	locale: 'en' | 'zh';
	bookmarks: (typeof bookmark)[];
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
		if (path === '/me/bookmarks') return route.fulfill({ json: { items: state.bookmarks, next_cursor: null } });
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

async function expectBookmarkAlignment(page: Page) {
	const metrics = await page.locator('section[aria-labelledby="bookmarks-heading"]').evaluate((section) => {
		const panel = section.closest('#main-content > div');
		const content = section.querySelector('ul > li') ?? section.querySelector('p');
		if (!(panel instanceof HTMLElement) || !(content instanceof HTMLElement)) {
			throw new Error('The bookmarks panel or its content is missing');
		}
		const style = getComputedStyle(panel);
		const panelBox = panel.getBoundingClientRect();
		const sectionBox = section.getBoundingClientRect();
		const contentBox = content.getBoundingClientRect();
		return {
			expectedLeft: panelBox.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
			expectedRight: panelBox.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight),
			sectionLeft: sectionBox.left, sectionRight: sectionBox.right, sectionTop: sectionBox.top,
			contentLeft: contentBox.left, contentRight: contentBox.right, contentTop: contentBox.top
		};
	});
	expect(Math.abs(metrics.sectionLeft - metrics.expectedLeft)).toBeLessThan(1);
	expect(Math.abs(metrics.sectionRight - metrics.expectedRight)).toBeLessThan(1);
	expect(Math.abs(metrics.contentLeft - metrics.sectionLeft)).toBeLessThan(1);
	expect(Math.abs(metrics.contentRight - metrics.sectionRight)).toBeLessThan(1);
	expect(Math.abs(metrics.contentTop - metrics.sectionTop)).toBeLessThan(1);
}

test('menu destinations keep accessible titles without repeated visible introductions', async ({ page }) => {
	test.setTimeout(90_000);
	const unexpected = await mockApi(page, { locale: 'en', bookmarks: [bookmark] });
	await page.setViewportSize({ width: 1600, height: 900 });
	const destinations = [
		{ path: '/', heading: 'Dashboard', description: 'Your books, arranged your way.' },
		{ path: '/books', heading: 'All Books', description: 'Every book you can access, across all of your libraries.' },
		{ path: '/bookheap', heading: 'Bookheap', description: 'Files waiting to be added to a library. Scan the server folder or upload files, then assign them to a library and shelves.' },
		{ path: '/bookmarks', heading: 'Bookmarks', description: 'Your saved reading positions across books.' },
		{ path: '/notes', heading: 'Notes and highlights', description: 'Search your own notes and highlights, then download them as Markdown.' },
		{ path: '/shelves', heading: 'Shelves', description: 'Organize books on your private shelves and browse shared shelves.' },
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
		await expect(main.getByRole('heading', { name: destination.heading, level: 1, exact: true })).toHaveClass('sr-only');
		if (destination.description) await expect(main.getByText(destination.description, { exact: true })).toHaveCount(0);
		if (destination.path === '/settings') {
			await page.getByRole('button', { name: 'Account menu', exact: true }).click();
			await expect(page.getByRole('menuitem', { name: 'Profile', exact: true }))
				.toHaveAttribute('aria-current', 'page');
		} else if (destination.path === '/shelves') {
			const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
			await sidebar.getByRole('button', { name: 'Shelf actions' }).click();
			await expect(sidebar.getByRole('menuitem', { name: 'Manage shelves' }))
				.toHaveAttribute('aria-current', 'page');
			await page.keyboard.press('Escape');
		} else {
			await expect(page.getByRole('navigation', { name: 'Main navigation' }).locator(`a[href="${destination.path}"]`))
				.toHaveAttribute('aria-current', 'page');
		}
	}

	await page.goto('/books');
	await expect(page.getByRole('main').getByRole('heading', { name: 'Books', level: 2 })).toHaveClass('sr-only');
	await page.goto('/library/1');
	await expect(page.getByRole('main').getByRole('heading', { name: 'Fiction', level: 1 })).toBeVisible();
	await expect(page.getByRole('main').getByRole('heading', { name: 'Books', level: 2 })).toBeVisible();
	expect(unexpected).toEqual([]);
});

test('bookmark empty and populated states align with the content panel on desktop and mobile', async ({ page }) => {
	const state: MockState = { locale: 'en', bookmarks: [] };
	const unexpected = await mockApi(page, state);
	for (const width of [1600, 390]) {
		await page.setViewportSize({ width, height: 900 });
		state.bookmarks = [];
		await page.goto('/bookmarks');
		await expect(page.getByText('No bookmarks saved yet.')).toBeVisible();
		await expectBookmarkAlignment(page);

		state.bookmarks = [bookmark];
		await page.reload();
		const card = page.getByRole('listitem').filter({ hasText: 'A Book' });
		await expect(card).toBeVisible();
		await expectBookmarkAlignment(page);
		await expect(card.getByRole('link', { name: 'Open bookmark' })).toHaveAttribute('href', '/read/21/31?bookmark=bookmark-1');
		await card.getByRole('button', { name: 'Edit', exact: true }).click();
		await expect(card.getByLabel('Label (optional)')).toHaveValue('Saved page one');
		await card.getByRole('button', { name: 'Cancel' }).click();
		await expect(card.getByText('Saved page one')).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth))
			.toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
	}
	expect(unexpected).toEqual([]);
});

test('shelf descriptions remain available without showing introductory text by default', async ({ page }) => {
	const unexpected = await mockApi(page, { locale: 'en', bookmarks: [] });
	await page.goto('/shelves/11');
	await expect(page.getByText('Picked for weekends.')).toBeHidden();
	await page.getByText('Shelf details', { exact: true }).click();
	await expect(page.getByText('Picked for weekends.')).toBeVisible();
	await page.goto('/shelves/system/favorites');
	await expect(page.getByText('Books marked as favorites.')).toBeHidden();
	await page.getByText('Shelf details', { exact: true }).click();
	await expect(page.getByText('Books marked as favorites.')).toBeVisible();
	expect(unexpected).toEqual([]);
});

test('localized bookmarks retain their accessible title and aligned mobile layout', async ({ page }) => {
	const unexpected = await mockApi(page, { locale: 'zh', bookmarks: [bookmark] });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/zh/bookmarks');
	await expect(page.getByRole('main').getByRole('heading', { name: '书签', level: 1 })).toHaveClass('sr-only');
	await expect(page.getByText('查看各本书中保存的阅读位置。')).toHaveCount(0);
	await expect(page.getByText('Saved page one')).toBeVisible();
	await expectBookmarkAlignment(page);
	expect(await page.evaluate(() => document.documentElement.scrollWidth))
		.toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
	expect(unexpected).toEqual([]);
});
