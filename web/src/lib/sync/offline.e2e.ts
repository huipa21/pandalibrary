import { expect, test, type Page } from '@playwright/test';
import { pdfFixture } from '../reader/fixtures';
import { openAnnotationsPanel } from '../real-pdf.js';

type Mutation = {
	entity: string; key?: string; id?: string; op: string;
	data: Record<string, unknown>; updated_at: number;
};

async function setup(page: Page) {
	const bytes = pdfFixture();
	const file = {
		id: 31, format: 'pdf', size_bytes: bytes.length, original_filename: 'Offline Fixture.pdf',
		created_at: '2026-11-03T00:00:00Z', download_url: `/api/v1/books/21/files/31?v=${'a'.repeat(64)}`
	};
	const book = {
		id: 21, library_id: 1, title: 'Offline Fixture', sort_title: 'Offline Fixture', subtitle: null,
		description: null, language: 'en', publisher: null, published_date: null, page_count: null,
		cover_url: '/api/v1/books/21/cover', cover_source: null, authors: [], series: null, tags: [], identifiers: [],
		files: [file], field_sources: [], created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z'
	};
	const state = {
		online: true, denial: 0, fileDenial: 0, account: 1, authenticated: true, rev: 0,
		rejection: null as string | null,
		progress: null as Record<string, unknown> | null,
		notes: [] as Record<string, unknown>[],
		mutations: [] as Mutation[], calls: [] as string[]
	};
	// Exercise the online/visible retry path used by browsers without Background Sync.
	await page.addInitScript(() => {
		Object.defineProperty(ServiceWorkerRegistration.prototype, 'sync', { value: undefined, configurable: true });
	});
	await page.route('**/api/v1/**', async (route) => {
		if (!state.online) return route.abort('internetdisconnected');
		const url = new URL(route.request().url());
		const path = url.pathname.slice('/api/v1'.length);
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') {
			state.calls.push('me');
			return route.fulfill({
				status: state.authenticated ? 200 : 401,
				json: { user: { id: state.account, username: 'reader', display_name: '', role: 'user', locale: 'en' } }
			});
		}
		if (path === '/auth/logout') {
			state.authenticated = false;
			return route.fulfill({ json: { logged_out: true } });
		}
		if (path === '/me/profile') {
			return route.fulfill({ json: { user: { id: state.account, username: 'reader', display_name: '', role: 'user', locale: 'en' } } });
		}
		if (path === '/me/app-passwords') return route.fulfill({ json: { app_passwords: [] } });
		if (path === '/books') return route.fulfill({ json: { items: [book], next_cursor: null } });
		if (path.startsWith('/books/21') && state.denial) {
			return route.fulfill({ status: state.denial, json: { title: 'Denied', status: state.denial } });
		}
		if (path === '/books/21') return route.fulfill({ json: { book } });
		if (path === '/books/21/files/31') {
			return route.fulfill({
				status: state.fileDenial || 200, contentType: 'application/pdf', body: bytes,
				headers: { 'cache-control': 'private, max-age=31536000, immutable' }
			});
		}
		if (path === '/books/21/cover') {
			return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' });
		}
		if (path === '/libraries/1') return route.fulfill({ json: { library: { id: 1, name: 'Offline library', slug: 'offline', created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z' } } });
		if (path === '/shelves') return route.fulfill({ json: { items: [], next_cursor: null } });
		if (path === '/me/books/21') {
			return route.fulfill({ json: { user_book: null, progress: state.progress, highlights: [], notes: state.notes } });
		}
		if (path === '/me/books/21/reading-summary') return route.fulfill({ json: { summary: {
			progress: 0, sessions: 0, total_seconds: 0, average_seconds: 0, active_days: 0, span_days: 0,
			first_read_at: null, last_read_at: null, pace_percent_per_hour: null, estimated_seconds_left: null,
			records: { longest_session: null, best_day: null, longest_streak_days: 0 }, attempts: [], days: []
		} } });
		if (path === '/me/settings') return route.fulfill({ json: { settings: [] } });
		if (path === '/sync/push') {
			state.calls.push('push');
			const { mutations } = route.request().postDataJSON() as { mutations: Mutation[] };
			if (state.rejection) {
				state.mutations.push(...mutations);
				return route.fulfill({ json: {
					results: mutations.map((_, index) => ({ index, status: 'rejected', reason: state.rejection }))
				} });
			}
			for (const mutation of mutations) {
				state.mutations.push(mutation);
				const now = new Date(mutation.updated_at).toISOString();
				state.rev += 1;
				if (mutation.entity === 'reading_progress') {
					state.progress = { ...mutation.data, updated_at: now, rev: state.rev };
				} else if (mutation.entity === 'notes') {
					state.notes = state.notes.filter((note) => note.id !== mutation.id);
					state.notes.push({
						...mutation.data, id: mutation.id, created_at: now, updated_at: now,
						deleted_at: mutation.op === 'delete' ? now : null, rev: state.rev
					});
				}
			}
			return route.fulfill({ json: { results: mutations.map((_, index) => ({ index, status: 'applied' })) } });
		}
		if (path === '/sync/pull') {
			state.calls.push('pull');
			const cursor = Number(url.searchParams.get('cursor'));
			return route.fulfill({ json: {
				cursor: state.rev, user_books: [], highlights: [], user_settings: [],
				reading_progress: state.progress && Number(state.progress.rev) > cursor ? [state.progress] : [],
				notes: state.notes.filter((note) => Number(note.rev) > cursor)
			} });
		}
		return route.fulfill({ status: 404, json: { title: 'Unknown fixture endpoint', status: 404 } });
	});
	return state;
}

async function databaseRows(page: Page, store: string): Promise<Array<Record<string, unknown>>> {
	return page.evaluate((name) => new Promise((resolve, reject) => {
		const request = indexedDB.open('pandalibrary-offline');
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			const database = request.result;
			const transaction = database.transaction(name);
			const all = transaction.objectStore(name).getAll();
			transaction.oncomplete = () => { database.close(); resolve(all.result); };
			transaction.onabort = () => { database.close(); reject(transaction.error); };
		};
	}), store);
}

async function queueFixture(page: Page, mutation: Mutation, status: 'pending' | 'stale') {
	await page.evaluate(({ mutation, status }) => new Promise<void>((resolve, reject) => {
		const opening = indexedDB.open('pandalibrary-offline');
		opening.onerror = () => reject(opening.error);
		opening.onsuccess = () => {
			const database = opening.result;
			const transaction = database.transaction('outbox', 'readwrite');
			transaction.objectStore('outbox').add({ account: 1, status, mutation });
			transaction.oncomplete = () => { database.close(); resolve(); };
			transaction.onabort = () => { database.close(); reject(transaction.error); };
		};
	}), { mutation, status });
}

test('a genuine rejection links to its reason and can be discarded explicitly', async ({ page }) => {
	const state = await setup(page);
	await page.goto('/books/21');
	await expect(page.getByRole('heading', { name: 'Offline Fixture' })).toBeVisible();
	// The layout and activateOffline() each confirm the session; listeners exist after the second.
	await expect.poll(() => state.calls.filter((call) => call === 'me').length).toBeGreaterThanOrEqual(2);
	await page.evaluate(() => navigator.locks.request('pandalibrary-session-and-sync', () => undefined));
	expect(state.calls).not.toContain('pull');
	state.rejection = 'book is unavailable';
	await queueFixture(page, {
		entity: 'notes', id: '019a4d48-cc00-7000-8000-000000000001', op: 'upsert',
		data: { book_id: 21, highlight_id: 'highlight', body_md: 'Unsynced note' }, updated_at: Date.now()
	}, 'pending');
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	await expect(page.getByText('Some changes were rejected or conflicted. Review them in offline storage settings.')).toBeVisible();
	await page.getByRole('link', { name: 'Review changes' }).click();
	await expect(page).toHaveURL('/settings#offline-storage-heading');
	const storage = page.getByRole('region', { name: 'Offline storage' });
	await expect(storage.getByText('Rejected by the server')).toBeVisible();
	await expect(storage.getByText('Server reason: book is unavailable')).toBeVisible();
	await expect(storage.getByRole('link', { name: 'Book #21' })).toHaveAttribute('href', '/books/21');
	page.once('dialog', (dialog) => void dialog.accept());
	await storage.getByRole('button', { name: 'Discard change' }).click();
	await expect(storage.getByText('No queued changes.')).toBeVisible();
	await expect(page.getByText('Some changes were rejected or conflicted. Review them in offline storage settings.')).toHaveCount(0);
});

test('storage settings refresh when an explicit sync reconciles an existing conflict', async ({ page }) => {
	const state = await setup(page);
	await page.goto('/settings');
	const storage = page.getByRole('region', { name: 'Offline storage' });
	await expect(storage.getByText('No queued changes.')).toBeVisible();
	// The layout and activateOffline() each confirm the session; listeners exist after the second.
	await expect.poll(() => state.calls.filter((call) => call === 'me').length).toBeGreaterThanOrEqual(2);
	await page.evaluate(() => navigator.locks.request('pandalibrary-session-and-sync', () => undefined));
	await queueFixture(page, {
		entity: 'user_settings', key: 'reader.pdf', op: 'upsert',
		data: { value: { theme: 'dark' } }, updated_at: Date.now()
	}, 'stale');

	let releasePull = () => {};
	const held = new Promise<void>((resolve) => { releasePull = resolve; });
	let pullStarted = false;
	await page.route('**/api/v1/sync/pull?*', async (route) => {
		pullStarted = true;
		await held;
		await route.fulfill({ json: {
			cursor: 1, user_books: [], reading_progress: [], highlights: [], bookmarks: [],
			page_annotations: [], notes: [],
			user_settings: [{ key: 'reader.pdf', value: { theme: 'dark' }, updated_at: '2026-11-03T00:00:00Z', rev: 1 }]
		} });
	});
	try {
		await page.reload();
		await expect(storage.getByText('Conflicts with a newer server change')).toBeVisible();
		// Without an open reader, loading a page only pushes; pulling needs an explicit sync.
		expect(pullStarted).toBe(false);
		await storage.getByRole('button', { name: 'Retry sync' }).click();
		await expect.poll(() => pullStarted).toBe(true);
	} finally {
		releasePull();
	}
	await expect(storage.getByText('No queued changes.')).toBeVisible();
	await expect(page.getByText('Some changes were rejected or conflicted. Review them in offline storage settings.')).toHaveCount(0);
});

async function download(page: Page) {
	await page.goto('/books/21/files');
	const panel = page.getByRole('region', { name: 'Files', exact: true });
	await panel.getByRole('button', { name: 'Actions for Offline Fixture.pdf' }).click();
	await panel.getByRole('menuitem', { name: 'Save for offline' }).click();
	await expect(page.getByText('Book file downloaded for offline reading.', { exact: true })).toBeVisible();
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller) {
			await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
		}
	});
}

test('book details use synced state and the cached cover while offline', async ({ page, context }) => {
	const state = await setup(page);
	state.rev = 1;
	state.notes.push({
		id: '019a4d48-cc00-7000-8000-000000000001', book_id: 21, highlight_id: 'highlight',
		body_md: 'A synchronized review', created_at: '2026-11-03T00:00:00Z',
		updated_at: '2026-11-03T00:00:00Z', deleted_at: null, rev: 1
	});
	await download(page);
	await page.goto('/books/21');
	await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
	state.online = false;
	await context.setOffline(true);
	await page.goto('/books/21');
	await expect(page.getByRole('heading', { name: 'Offline Fixture' })).toBeVisible();
	await expect(page.getByText('A synchronized review', { exact: true })).toHaveCount(0);
	await expect(page.getByText('Reviews are available when you\'re online.', { exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Back to library' })).toHaveCount(0);
	await expect(page.getByRole('img', { name: 'Offline Fixture' })).toHaveAttribute('src', /^blob:/);
	await expect(page.getByRole('region', { name: 'Your reading' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Edit metadata' })).toHaveCount(0);
	await expect(page.getByText('Reading details are read-only while offline.')).toBeVisible();
});

test('offline progress survives reload and reconnect without a standalone book note writer', async ({ page, context }) => {
	const state = await setup(page);
	await download(page);
	await page.goto('/read/21/31');
	const pageBox = page.getByRole('textbox', { name: /^Page \d+ of \d+$/ });
	await expect(pageBox).toBeEnabled();
	// Push-only syncs keep confirmed writes until the next reader pull reconciles them.
	await expect.poll(async () => (await databaseRows(page, 'outbox')).filter((row) => row.status !== 'applied').length).toBe(0);

	state.online = false;
	await context.setOffline(true);
	await pageBox.fill('2');
	await pageBox.press('Enter');
	await expect(page.locator('.reader-pdf-page[data-page="2"] .reader-pdf-text')).toContainText('Second PDF page text');
	const annotationsPanel = await openAnnotationsPanel(page);
	await expect(annotationsPanel.getByRole('region', { name: 'Book notes' })).toHaveCount(0);
	await expect(annotationsPanel.getByRole('button', { name: 'Add book note' })).toHaveCount(0);
	// The reader saves a changed position at most every 10 seconds.
	await expect.poll(async () => (await databaseRows(page, 'outbox')).filter((row) => row.status === 'pending').length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

	await page.reload();
	await expect(page.locator('.reader-pdf-page[data-page="2"] .reader-pdf-text')).toContainText('Second PDF page text');
	await expect(pageBox).toHaveValue('2');
	await openAnnotationsPanel(page);
	await expect(page.getByRole('region', { name: 'Book notes' })).toHaveCount(0);
	const countBefore = state.mutations.length;
	state.calls.length = 0;
	state.online = true;
	await context.setOffline(false);
	await expect.poll(async () => (await databaseRows(page, 'outbox')).length).toBe(0);
	expect(state.mutations.length).toBeGreaterThan(countBefore);
	expect(state.progress?.percentage).toBe(1);
	expect(state.calls.indexOf('push')).toBeLessThan(state.calls.indexOf('pull'));
	const saved = await databaseRows(page, 'rows');
	expect(saved.some((row) => row.entity === 'reading_progress' && JSON.stringify(row.value).includes('"percentage":1'))).toBe(true);
});

for (const status of [403, 404]) {
	test(`authenticated ${status} evicts downloaded file, detail and cover`, async ({ page }) => {
		const state = await setup(page);
		await download(page);
		expect(await databaseRows(page, 'files')).toHaveLength(1);
		expect(await databaseRows(page, 'books')).toHaveLength(1);
		state.denial = status;
		await page.reload();
		await expect(page.getByRole('alert')).toBeVisible();
		await expect.poll(async () => (await databaseRows(page, 'files')).length).toBe(0);
		expect(await databaseRows(page, 'books')).toEqual([]);
	});
}

test('a denied online file is revalidated and evicted rather than served from an HTTP cache', async ({ page }) => {
	const state = await setup(page);
	await download(page);
	state.fileDenial = 403;
	await page.goto('/read/21/31');
	await expect(page.getByRole('alert')).toContainText('The reader request failed.');
	expect(await databaseRows(page, 'files')).toEqual([]);
	expect(await databaseRows(page, 'books')).toEqual([]);
});

test('account changes and logout cannot expose a previous account download offline', async ({ page, context }) => {
	const state = await setup(page);
	await download(page);
	state.account = 2;
	await page.goto('/read');
	await expect(page.getByRole('heading', { name: 'Choose a book to read' })).toBeVisible();
	state.online = false;
	await context.setOffline(true);
	await page.reload();
	await expect(page.getByText('Only books downloaded to this device are shown while offline.')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Offline Fixture' })).toHaveCount(0);
	state.online = true;
	await context.setOffline(false);
	await page.getByRole('button', { name: 'Account menu' }).click();
	await page.getByRole('menuitem', { name: 'Sign out' }).click();
	await expect(page).toHaveURL('/login');
	state.online = false;
	await context.setOffline(true);
	await page.goto('/read/21/31');
	await expect(page.getByRole('heading', { name: 'Offline Fixture' })).toHaveCount(0);
	await expect(page.locator('.reader-pdf-text')).toHaveCount(0);
});
