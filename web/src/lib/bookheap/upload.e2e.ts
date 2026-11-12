import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

async function authenticate(page: Page, role = 'admin', locale = 'en') {
	await page.route('**/api/v1/sync/pull?*', (route) => route.fulfill({ json: {
		cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: []
	} }));
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) =>
		route.fulfill({ json: { user: { id: 1, username: 'admin', display_name: 'Admin', role, locale } } })
	);
	await page.route('**/api/v1/shelves?*', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
	await page.route('**/api/v1/admin/libraries?*', (route) => route.fulfill({ json: { items: [
		{ id: 2, name: 'Main', slug: 'main', created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z' }
	], next_cursor: null } }));
	for (const [key, id] of [['unshelved', 8], ['favorites', 9]] as const) {
		await page.route(`**/api/v1/shelves/system/${key}`, (route) => route.fulfill({ json: { shelf: {
			id, kind: 'private', mode: 'system', system_key: key, owner_id: 1, name: key,
			description: null, created_by: 1, visible_book_count: 0,
			created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z'
		} } }));
	}
}

function heapItem(id: number, fileName: string, title: string) {
	return {
		id, file_name: fileName, rel_path: fileName, format: 'epub', size_bytes: 4, sha256: 'a'.repeat(64),
		title, authors: [], language: null, series: null, series_index: null, has_cover: false, cover_url: null,
		source: 'upload', status: 'ready', error: null, duplicate_of_book_id: null, duplicate_of_item_id: null,
		target_library_id: null, target_shelf_ids: [], import_job_id: null, added_by: 1,
		created_at: '2026-11-06T05:00:00Z', updated_at: '2026-11-06T05:00:00Z'
	};
}

const problem = (route: Route, status: number, extra: Record<string, unknown> = {}) =>
	route.fulfill({ status, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Error', status, ...extra }) });

/** Holds every upload until `release()` and answers per file name. */
async function mockUploads(page: Page) {
	const names: string[] = [];
	const visibilities: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/api/v1/admin/bookheap/files', async (route) => {
		const body = route.request().postDataBuffer()?.toString('latin1') ?? '';
		const name = /filename="([^"]+)"/.exec(body)?.[1] ?? '';
		names.push(name);
		visibilities.push(/name="visibility"\r\n\r\n([^\r]+)/.exec(body)?.[1] ?? '');
		await gate;
		const reply = () => {
			if (name === 'Dune.epub') return route.fulfill({ status: 201, json: { item: heapItem(12, name, 'Dune') } });
			if (name === 'Copy.pdf') return problem(route, 409, { duplicate_of_book_id: 4 });
			if (name === 'Heap.mobi') return problem(route, 409, { duplicate_of_item_id: 9 });
			return problem(route, 503);
		};
		// Aborted requests can no longer be fulfilled.
		await reply().catch(() => undefined);
	});
	return { names, visibilities, release };
}

const book = (name: string) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from('book') });

async function dropFiles(zone: Locator, files: string[], text?: string) {
	const dataTransfer = await zone.page().evaluateHandle(({ files, text }) => {
		const transfer = new DataTransfer();
		for (const name of files) transfer.items.add(new File(['book'], name, { lastModified: 1 }));
		if (text) transfer.items.add(text, 'text/uri-list');
		return transfer;
	}, { files, text });
	await zone.dispatchEvent('dragenter', { dataTransfer });
	await expect(zone).toHaveAttribute('data-dragging', 'true');
	await zone.dispatchEvent('dragover', { dataTransfer });
	await zone.dispatchEvent('drop', { dataTransfer });
	await expect(zone).not.toHaveAttribute('data-dragging', 'true');
}

test('administrators upload many files from the header dialog with per-file results', async ({ page }) => {
	await authenticate(page);
	const uploads = await mockUploads(page);
	const changes: number[] = [];
	await page.exposeFunction('recordBookheapChange', () => changes.push(Date.now()));
	await page.addInitScript(() => {
		window.addEventListener('pandalibrary-bookheap-changed', () => (window as unknown as { recordBookheapChange: () => void }).recordBookheapChange());
	});
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/');

	const trigger = page.getByRole('banner').getByRole('button', { name: 'Upload', exact: true });
	await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
	await trigger.click();
	const dialog = page.getByRole('dialog', { name: 'Upload books' });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Select files' })).toBeFocused();
	await expect(dialog.getByText('No files yet.', { exact: false })).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Clear' })).toBeDisabled();
	await expect(dialog.getByLabel('Library (optional)')).toHaveValue('');
	const visibility = dialog.getByLabel('Book visibility');
	await expect(visibility).toHaveValue('public');
	await expect(dialog.getByText('Public books are visible to all signed-in users', { exact: false })).toBeVisible();
	await visibility.selectOption('private');
	const upload = dialog.getByRole('button', { name: /^(Upload|Uploading…)$/ });
	await expect(upload).toBeDisabled();
	await expect(dialog.getByTestId('bh3-file-input')).toHaveAttribute('accept', '.epub,.pdf,.mobi,.azw3,.fb2,.fbz,.cbz');

	const zone = dialog.getByTestId('bh3-drop-zone');
	await expect(zone).toContainText('Drag and drop book files here');
	await dropFiles(zone, [], 'https://example.com/book');
	await expect(dialog.getByRole('status')).toHaveText('Folders and items that are not files were ignored.');
	await dropFiles(zone, ['Dune.epub', 'notes.txt']);
	await expect(dialog.getByRole('status')).toHaveText('Not added, unsupported format: notes.txt');
	await dialog.getByRole('button', { name: 'Dismiss notice' }).click();
	await expect(dialog.getByRole('status')).toHaveCount(0);

	const chooser = page.waitForEvent('filechooser');
	await dialog.getByRole('button', { name: 'Select files' }).click();
	await (await chooser).setFiles([book('Copy.pdf'), book('Heap.mobi'), book('Flaky.cbz'), book('Gone.fb2')]);
	const list = dialog.getByRole('list', { name: 'Files to upload' });
	await expect(list.getByRole('listitem')).toHaveCount(5);
	await expect(dialog.getByTestId('bh3-summary')).toHaveText('5 files, 20 B');

	await dropFiles(zone, ['Dune.epub']);
	await expect(list.getByRole('listitem')).toHaveCount(5);

	await dialog.getByRole('button', { name: 'Remove Gone.fb2' }).click();
	await expect(list.getByRole('listitem')).toHaveCount(4);
	await expect(list).not.toContainText('Gone.fb2');

	await upload.click();
	await expect(upload).toHaveText('Uploading…');
	await expect(upload).toBeDisabled();
	await expect(upload).toBeFocused();
	await expect(dialog.getByRole('progressbar')).toHaveCount(2);
	await expect(dialog.getByRole('progressbar', { name: 'Upload progress for Dune.epub' })).toHaveAttribute('aria-valuemax', '100');
	await expect(dialog.getByRole('button', { name: 'Remove Dune.epub' })).toBeDisabled();
	await expect(dialog.getByRole('button', { name: 'Clear' })).toBeDisabled();
	await expect(visibility).toBeDisabled();
	await expect(dialog.getByRole('button', { name: 'Remove Flaky.cbz' })).toBeEnabled();
	await expect.poll(() => uploads.names).toEqual(['Dune.epub', 'Copy.pdf']);

	uploads.release();
	await expect(dialog.getByTestId('bh3-result')).toHaveText('1 uploaded, 2 duplicate, 1 failed');
	const statuses = list.getByTestId('bh3-row-status');
	await expect(statuses).toHaveText(['Added as “Dune”', 'Already in your library', 'Already in Bookheap', 'Server error. You can retry.']);
	await expect(list.getByTestId('bh3-success-mark')).toHaveCount(1);
	await expect(list.locator('[data-status="done"]')).toHaveClass(/bg-emerald-50/);
	await expect(list.getByRole('link', { name: 'Already in your library' })).toHaveAttribute('href', '/books/4');
	await expect(dialog.getByRole('link', { name: 'View Bookheap' })).toHaveAttribute('href', '/bookheap');
	await expect(dialog.locator('[aria-live="polite"]')).toHaveText('1 uploaded, 2 duplicate, 1 failed');
	expect([...uploads.names].sort()).toEqual(['Copy.pdf', 'Dune.epub', 'Flaky.cbz', 'Heap.mobi']);
	expect(uploads.visibilities).toEqual(['private', 'private', 'private', 'private']);
	await expect.poll(() => changes.length).toBe(1);

	await visibility.selectOption('public');
	await dialog.getByRole('button', { name: 'Retry failed' }).click();
	await expect.poll(() => uploads.names.filter((name) => name === 'Flaky.cbz').length).toBe(2);
	await expect(dialog.getByRole('button', { name: 'Retry failed' })).toBeVisible();
	await expect(statuses.nth(3)).toHaveText('Server error. You can retry.');
	expect(changes).toHaveLength(1);
	expect(uploads.visibilities.at(-1)).toBe('private');

	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(trigger).toBeFocused();

	await trigger.click();
	await expect(visibility).toHaveValue('public');
	await expect(list.getByRole('listitem')).toHaveCount(3);
	await expect(list).not.toContainText('Dune.epub');
	await dialog.getByRole('button', { name: 'Clear' }).click();
	await expect(dialog.getByText('No files yet.', { exact: false })).toBeVisible();
	await dialog.getByRole('button', { name: 'Close' }).last().click();
	await expect(dialog).toBeHidden();
	await expect(trigger).toBeFocused();
});

test('uploads optionally assign a library and retry assignment failures without re-uploading', async ({ page }) => {
	await authenticate(page);
	let uploads = 0;
	let multipart = '';
	const assignments: unknown[] = [];
	await page.route('**/api/v1/admin/bookheap/files', (route) => {
		uploads += 1;
		multipart = route.request().postDataBuffer()?.toString('latin1') ?? '';
		return route.fulfill({ status: 201, json: { item: heapItem(12, 'Dune.epub', 'Dune') } });
	});
	await page.route('**/api/v1/admin/bookheap/assign', (route) => {
		assignments.push(route.request().postDataJSON());
		if (assignments.length === 1) return problem(route, 503);
		return route.fulfill({ status: 202, json: { results: [{ id: 12, ok: true, error: null, import_job_id: 42 }] } });
	});
	await page.goto('/');
	await page.getByRole('banner').getByRole('button', { name: 'Upload', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Upload books' });
	await dialog.getByLabel('Library (optional)').selectOption({ label: 'Main' });
	await dialog.getByLabel('Book visibility').selectOption('private');
	await dialog.getByTestId('bh3-file-input').setInputFiles(book('Dune.epub'));
	await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
	await expect(dialog.getByTestId('bh3-row-status')).toHaveText('Uploaded, but library assignment failed. Retry or assign from Bookheap.');
	await expect(dialog.getByTestId('bh3-success-mark')).toHaveCount(0);
	await dialog.getByRole('button', { name: 'Retry failed' }).click();
	await expect(dialog.getByTestId('bh3-row-status')).toHaveText('Uploaded “Dune” — queued for library import');
	await expect(dialog.getByTestId('bh3-success-mark')).toBeVisible();
	await expect(dialog.getByTestId('bh3-result')).toHaveText('1 uploaded, 0 duplicate, 0 failed');
	expect(uploads).toBe(1);
	expect(multipart).toContain('name="visibility"\r\n\r\nprivate');
	expect(assignments).toEqual([
		{ ids: [12], library_id: 2, shelf_ids: [] },
		{ ids: [12], library_id: 2, shelf_ids: [] }
	]);
});

test('closing during an upload asks for confirmation and aborts in-flight files', async ({ page }) => {
	await authenticate(page);
	const uploads = await mockUploads(page);
	await page.goto('/');
	const trigger = page.getByRole('banner').getByRole('button', { name: 'Upload', exact: true });
	await trigger.click();
	const dialog = page.getByRole('dialog', { name: 'Upload books' });
	await dialog.getByTestId('bh3-file-input').setInputFiles([book('One.epub'), book('Two.epub'), book('Three.epub')]);
	await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
	await expect(dialog.getByRole('progressbar')).toHaveCount(2);
	await expect.poll(() => uploads.names).toEqual(['One.epub', 'Two.epub']);

	await page.keyboard.press('Escape');
	await expect(dialog.getByRole('alert')).toContainText('Uploads are still in progress');
	await expect(dialog.getByRole('button', { name: 'Keep uploading' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(dialog.getByRole('alert')).toHaveCount(0);
	await expect(dialog).toBeVisible();

	await dialog.getByRole('button', { name: 'Close' }).last().click();
	await dialog.getByRole('button', { name: 'Stop and close' }).click();
	await expect(dialog).toBeHidden();
	await expect(trigger).toBeFocused();
	expect(uploads.names).toEqual(['One.epub', 'Two.epub']);

	await trigger.click();
	await expect(dialog.getByTestId('bh3-row-status')).toHaveText(['Waiting', 'Waiting', 'Waiting']);
	uploads.release();
});

test('non-administrators do not see the Upload button', async ({ page }) => {
	await authenticate(page, 'user');
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
	await expect(page.getByRole('banner').getByRole('button', { name: 'Upload' })).toHaveCount(0);
});

test('the Upload button is icon-only on narrow screens and hidden on reader routes', async ({ page }) => {
	await authenticate(page, 'admin', 'zh');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	const trigger = page.getByRole('banner').getByRole('button', { name: '上传', exact: true });
	await expect(trigger).toBeVisible();
	const width = (await trigger.boundingBox())?.width ?? 0;
	expect(width).toBeLessThan(48);
	await trigger.click();
	await expect(page.getByRole('dialog', { name: '上传图书' })).toBeVisible();
	await page.keyboard.press('Escape');

	await page.goto('/read/21/1');
	await expect(page.getByRole('button', { name: '打开导航菜单' })).toBeVisible();
	await expect(page.getByRole('banner').getByRole('button', { name: '上传' })).toHaveCount(0);
});
