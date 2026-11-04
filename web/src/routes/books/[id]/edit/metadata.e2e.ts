import { expect, test, type Page } from '@playwright/test';

const HASH = 'a'.repeat(64);

function baseBook(overrides: Record<string, unknown> = {}) {
	return {
		id: 21,
		library_id: 1,
		title: 'Old Title',
		sort_title: 'Old Title',
		subtitle: 'Old subtitle',
		description: null,
		language: 'en',
		publisher: null,
		published_date: null,
		page_count: null,
		cover_url: null,
		cover_source: null,
		authors: [{ id: 4, name: 'A Writer', role: 'author', position: 0 }],
		series: null,
		tags: [],
		identifiers: [],
		files: [],
		field_sources: [],
		created_at: '2026-11-04T00:00:00Z',
		updated_at: '2026-11-04T00:00:00Z',
		...overrides
	};
}

function candidate(overrides: Record<string, unknown> = {}) {
	return {
		provider: 'openlibrary',
		reference: '/works/OL1W',
		title: 'New Title',
		subtitle: null,
		authors: [{ name: 'First Author', role: 'author' }, { name: 'Second Person', role: 'translator' }],
		description: 'Provider description',
		publisher: 'Provider Press',
		published_date: '2020-05',
		language: 'en',
		page_count: 320,
		series: { name: 'Saga', index: null },
		tags: ['Fantasy'],
		identifiers: [{ scheme: 'isbn13', value: '9780000000002' }],
		cover_url: 'https://covers.openlibrary.org/b/id/1-L.jpg',
		...overrides
	};
}

async function authenticate(page: Page, role = 'admin', locale = 'en') {
	await page.route('**/api/v1/sync/pull?*', (route) => route.fulfill({ json: {
		cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: []
	} }));
	await page.route('**/api/v1/setup', (route) => route.fulfill({ json: { required: false } }));
	await page.route('**/api/v1/auth/me', (route) =>
		route.fulfill({ json: { user: { id: 1, username: role, display_name: role, role, locale } } })
	);
	await page.route('**/api/v1/shelves**', (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
}

/** Builds a tiny valid single-page PDF with a correct cross-reference table. */
function minimalPdf(): Buffer {
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 4 0 R /Resources << >> >>',
		'<< /Length 44 >>\nstream\n0 0 1 rg 20 20 160 260 re f 0 0 0 RG\nendstream'
	];
	let body = '%PDF-1.4\n';
	const offsets: number[] = [];
	objects.forEach((object, index) => {
		offsets.push(Buffer.byteLength(body));
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = Buffer.byteLength(body);
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body, 'latin1');
}

test('admin compares candidates per field, recovers from a stale key, and applies references', async ({ page }) => {
	await authenticate(page);
	let current = baseBook();
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: current } }));
	await page.route('**/api/v1/books/21/cover', (route) => route.fulfill({ status: 404, body: '' }));
	let lookups = 0;
	await page.route('**/api/v1/books/21/metadata/candidates', async (route) => {
		expect(route.request().method()).toBe('POST');
		expect(route.request().postData() ?? '').toBe('');
		lookups += 1;
		await route.fulfill({
			json: {
				request_key: `key-${lookups}`,
				query: { title: 'Old Title' },
				providers: [
					{ provider: 'openlibrary', candidates: [candidate()], error: null },
					{ provider: 'googlebooks', candidates: [], error: { code: 'provider_unavailable', message: 'Unavailable' } },
					{ provider: 'neodb', candidates: [candidate({ provider: 'neodb', reference: 'uuid-1', title: 'Other Title', cover_url: null })], error: null }
				]
			}
		});
	});
	const coverRequests: unknown[] = [];
	await page.route('**/api/v1/books/21/metadata/cover', async (route) => {
		coverRequests.push(route.request().postDataJSON());
		const jpeg = Buffer.from(
			'/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
			'base64'
		);
		await route.fulfill({ body: jpeg, contentType: 'image/jpeg' });
	});
	const applies: Record<string, unknown>[] = [];
	await page.route('**/api/v1/books/21/metadata/apply', async (route) => {
		const body = route.request().postDataJSON() as Record<string, unknown>;
		applies.push(body);
		if (applies.length === 1) {
			await route.fulfill({
				status: 409,
				contentType: 'application/problem+json',
				body: JSON.stringify({ title: 'Conflict', status: 409 })
			});
			return;
		}
		current = baseBook({ title: 'New Title', publisher: 'Provider Press', cover_url: '/api/v1/books/21/cover', cover_source: 'openlibrary' });
		await route.fulfill({ json: { book: current } });
	});
	let externalRequests = 0;
	await page.route('https://covers.openlibrary.org/**', (route) => {
		externalRequests += 1;
		return route.abort();
	});

	await page.goto('/books/21');
	await page.getByRole('link', { name: 'Edit metadata' }).click();
	await expect(page.getByRole('heading', { name: 'Edit metadata: Old Title' })).toBeVisible();
	await page.getByRole('button', { name: 'Find metadata candidates' }).click();
	await expect(page.getByText('Found 2 candidates.')).toBeVisible();
	await expect(page.getByText('googlebooks could not be searched (code: provider_unavailable).')).toBeVisible();
	await expect(page.getByText('Unavailable', { exact: true })).toHaveCount(0);

	const title = page.getByRole('group', { name: 'Title', exact: true });
	await expect(title.getByRole('radio', { name: /^Keep current/ })).toBeChecked();
	await title.getByRole('radio', { name: 'openlibrary: New Title' }).check();
	const publisher = page.getByRole('group', { name: 'Publisher', exact: true });
	await publisher.getByRole('radio', { name: 'neodb: Other Title' }).check();
	const cover = page.getByRole('group', { name: 'Cover', exact: true });
	await expect(cover.getByRole('radio')).toHaveCount(2);
	await cover.getByRole('button', { name: 'Preview cover' }).click();
	await expect(cover.getByRole('img', { name: 'Cover preview from openlibrary' })).toHaveAttribute('src', /^blob:/);
	await cover.getByRole('radio', { name: 'openlibrary: New Title' }).check();
	expect(coverRequests).toEqual([{ request_key: 'key-1', provider: 'openlibrary', reference: '/works/OL1W' }]);

	await page.getByRole('button', { name: 'Apply selected fields (3)' }).click();
	await expect(page.getByRole('alert')).toContainText('expired or changed');
	await expect(page.getByText('Found 2 candidates.')).toBeVisible();
	expect(lookups).toBe(2);
	await expect(page.getByRole('button', { name: 'Apply selected fields (0)' })).toBeDisabled();
	await expect(title.getByRole('radio', { name: /^Keep current/ })).toBeChecked();

	await title.getByRole('radio', { name: 'openlibrary: New Title' }).check();
	await page.getByRole('group', { name: 'Publisher', exact: true }).getByRole('radio', { name: 'openlibrary: New Title' }).check();
	await page.keyboard.press('Tab');
	await page.getByRole('button', { name: 'Apply selected fields (2)' }).click();
	await expect(page.getByText('Metadata updated.')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Edit metadata: New Title' })).toBeVisible();
	expect(applies[1]).toEqual({
		request_key: 'key-2',
		fields: {
			title: { provider: 'openlibrary', reference: '/works/OL1W' },
			publisher: { provider: 'openlibrary', reference: '/works/OL1W' }
		}
	});
	expect(JSON.stringify(applies)).not.toContain('covers.openlibrary.org');
	expect(externalRequests).toBe(0);
});

test('non-administrators do not see the edit entry and are refused by the edit route', async ({ page }) => {
	await authenticate(page, 'user', 'zh');
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: baseBook() } }));
	await page.goto('/books/21');
	await expect(page.getByRole('heading', { name: 'Old Title' })).toBeVisible();
	await expect(page.getByRole('link', { name: '编辑元数据' })).toHaveCount(0);
	await page.goto('/books/21/edit');
	await expect(page.getByRole('alert')).toHaveText('只有管理员可以编辑图书元数据。');
});

test('generates a cover for a visible PDF without one and reports skipped books', async ({ page }) => {
	await authenticate(page);
	const pdfBook = baseBook({
		id: 31,
		title: 'PDF Without Cover',
		files: [{ id: 41, format: 'pdf', size_bytes: 600, download_url: `/api/v1/books/31/files/41?v=${HASH}` }]
	});
	const coveredLater = baseBook({
		id: 32,
		title: 'Covered Elsewhere',
		files: [{ id: 42, format: 'pdf', size_bytes: 600, download_url: `/api/v1/books/32/files/42?v=${HASH}` }]
	});
	const covered = baseBook({ id: 33, title: 'Has Cover', cover_url: '/api/v1/books/33/cover', files: [{ id: 43, format: 'pdf', size_bytes: 600, download_url: `/api/v1/books/33/files/43?v=${HASH}` }] });
	await page.route('**/api/v1/books/21', (route) => route.fulfill({ json: { book: baseBook() } }));
	await page.route('**/api/v1/books/31', (route) => route.fulfill({ json: { book: pdfBook } }));
	await page.route('**/api/v1/books/32', (route) =>
		route.fulfill({ json: { book: { ...coveredLater, cover_url: '/api/v1/books/32/cover' } } })
	);
	await page.route('**/api/v1/libraries?*', (route) => route.fulfill({ json: {
		items: [{ id: 1, name: 'Main', slug: 'main', created_at: '', updated_at: '' }], next_cursor: null
	} }));
	const bookQueries: string[] = [];
	await page.route('**/api/v1/books?*', (route) => {
		const params = new URL(route.request().url()).searchParams;
		bookQueries.push(params.toString());
		if (!params.has('cursor')) {
			return route.fulfill({ json: { items: [pdfBook, covered], next_cursor: 'opaque/+=' } });
		}
		return route.fulfill({ json: { items: [coveredLater], next_cursor: null } });
	});
	const downloads: string[] = [];
	await page.route('**/api/v1/books/*/files/*', (route) => {
		downloads.push(new URL(route.request().url()).pathname);
		return route.fulfill({ body: minimalPdf(), contentType: 'application/pdf' });
	});
	const uploads: { url: string; type: string | null; magic: string }[] = [];
	await page.route('**/api/v1/books/*/cover?*', async (route) => {
		const request = route.request();
		expect(request.method()).toBe('PUT');
		const body = request.postDataBuffer() ?? Buffer.alloc(0);
		uploads.push({ url: request.url(), type: await request.headerValue('content-type'), magic: body.subarray(0, 2).toString('hex') });
		await route.fulfill({ json: { cover_url: '/api/v1/books/31/cover' } });
	});

	await page.goto('/books/21/edit');
	await page.getByRole('button', { name: 'Generate missing covers' }).click();
	await expect(page.getByText('Cover generation finished.')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByText('Checked 3 books. Generated 1, skipped 1, failed 0.')).toBeVisible();
	await expect(page.locator('[data-outcome="generated"]')).toContainText('PDF Without Cover');
	await expect(page.locator('[data-outcome="skipped"]')).toContainText('it already has a cover');
	expect(uploads).toHaveLength(1);
	expect(new URL(uploads[0].url).pathname).toBe('/api/v1/books/31/cover');
	expect(new URL(uploads[0].url).searchParams.get('source')).toBe('pdfjs');
	expect(uploads[0].type).toBe('image/jpeg');
	expect(uploads[0].magic).toBe('ffd8');
	expect(downloads).toEqual(['/api/v1/books/31/files/41']);
	expect(new URLSearchParams(bookQueries[1]).get('cursor')).toBe('opaque/+=');
});
