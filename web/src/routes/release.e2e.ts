import { expect, test } from '@playwright/test';
import { realAdmin, signInRealAdmin } from '../lib/real-auth.js';
import { epubFixture } from '../lib/reader/fixtures';

test.skip(!process.env.PANDA_E2E_BINARY, 'Requires the compiled server and isolated first-run setup');

async function bookFrame(page: import('@playwright/test').Page) {
	await expect
		.poll(() => page.frames().some((frame) => frame.url().startsWith('blob:')))
		.toBe(true);
	const frame = page.frames().find((candidate) => candidate.url().startsWith('blob:'));
	if (!frame) throw new Error('The imported EPUB reader frame was not created.');
	return frame;
}

test('real server setup, admin library creation, and login', async ({ page }) => {
	test.setTimeout(90_000);
	await signInRealAdmin(page);
	await expect(page.getByRole('link', { name: 'Admin', exact: true })).toBeVisible();

	await page.goto('/admin/libraries');
	const form = page.getByRole('region', { name: 'New library' });
	await form.getByLabel('Name').fill('Release Library');
	await form.getByLabel('Slug').fill('release-library');
	await form.getByRole('button', { name: 'Create library' }).click();
	await expect(page.getByText('Created “Release Library”.')).toBeVisible();

	const ids = await page.evaluate(async () => {
		const response = await fetch('/api/v1/admin/libraries?limit=50');
		if (!response.ok) throw new Error(`library request failed: ${response.status}`);
		const payload = await response.json() as { items: Array<{ id: number; name: string }> };
		return payload.items.find((item) => item.name === 'Release Library')?.id;
	});
	expect(ids).toBeDefined();
	await page.goto(`/library/${ids}`);
	await expect(page.getByRole('heading', { name: 'Release Library' })).toBeVisible();

	await page.goto('/admin/imports');
	await page.getByLabel('Library').selectOption({ label: 'Release Library' });
	await page.getByLabel('Book file').setInputFiles({
		name: 'Release Fixture.epub',
		mimeType: 'application/epub+zip',
		buffer: epubFixture()
	});
	await page.getByRole('main').getByRole('button', { name: 'Upload', exact: true }).click();
	await expect(page.getByText(/Upload accepted as job #/)).toBeVisible();
	const imported = await expect
		.poll(async () => page.evaluate(async () => {
			const response = await fetch('/api/v1/imports?limit=50');
			if (!response.ok) throw new Error(`import history request failed: ${response.status}`);
			const payload = await response.json() as {
				items: Array<{ book_id: number | null; status: string; error: string | null }>;
			};
			const job = payload.items[0];
			if (job.status === 'failed') throw new Error(`import failed: ${job.error}`);
			return job;
		}), { timeout: 30_000 })
		.toMatchObject({ status: 'imported' })
		.then(() => page.evaluate(async () => {
			const response = await fetch('/api/v1/imports?limit=50');
			const payload = await response.json() as {
				items: Array<{ book_id: number | null; status: string; error: string | null }>;
			};
			return payload.items[0];
		}));
	expect(imported.book_id).toBeTruthy();

	await page.goto('/search?q=Fixture%20Book');
	await expect(page.getByRole('link', { name: 'Fixture Book', exact: true })).toBeVisible();
	const fileID = await page.evaluate(async (bookID) => {
		const response = await fetch(`/api/v1/books/${bookID}`);
		if (!response.ok) throw new Error(`book request failed: ${response.status}`);
		const payload = await response.json() as {
			book: { files: Array<{ id: number }> };
		};
		return payload.book.files[0]?.id;
	}, imported.book_id);
	expect(fileID).toBeDefined();
	await page.goto(`/read/${imported.book_id}/${fileID}`);
	await expect(page.getByRole('heading', { name: 'Fixture Book' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();
	const frame = await bookFrame(page);
	await frame.evaluate(() => {
		const passage = document.querySelector('#passage');
		if (!passage) throw new Error('The imported EPUB has no expected passage.');
		const range = document.createRange();
		range.selectNodeContents(passage);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		document.dispatchEvent(new Event('selectionchange'));
	});
	await page.getByRole('toolbar', { name: 'Selection actions', exact: true })
		.getByRole('button', { name: 'Highlight', exact: true }).click();
	await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
	await page.locator('.rp7-entry .rp7-edit').click();
	await page.getByRole('button', { name: 'Add note to highlight' }).click();
	await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Release validation note');
	await page.getByRole('button', { name: 'Save note' }).click();
	await page.getByRole('button', { name: 'Close annotation details' }).click();
	await page.getByRole('button', { name: 'Next page' }).click();
	await expect.poll(async () => page.evaluate(async (bookID) => {
		const response = await fetch(`/api/v1/me/books/${bookID}`);
		if (!response.ok) throw new Error(`reading state request failed: ${response.status}`);
		const state = await response.json() as {
			highlights: unknown[];
			notes: unknown[];
			progress: unknown;
		};
		return { highlights: state.highlights.length, notes: state.notes.length, progress: Boolean(state.progress) };
	}, imported.book_id)).toMatchObject({ highlights: 1, notes: 1, progress: true });

	await page.goto('/notes');
	const notesSearch = page.getByRole('searchbox', { name: 'Search annotations', exact: true });
	await notesSearch.fill('Release validation note');
	await notesSearch.press('Enter');
	await expect(page.getByText('Release validation note', { exact: true })).toBeVisible();
	await page.getByText('Export notes', { exact: true }).click();
	await page.getByRole('checkbox', { name: /Book \d+ \(matches: 1\)/ }).check();
	const markdownDownload = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Download Markdown' }).click();
	expect((await markdownDownload).suggestedFilename()).toContain('Fixture Book');

	await page.goto('/shelves');
	const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
	await sidebar.getByRole('button', { name: 'Collection actions' }).click();
	await sidebar.getByRole('menuitem', { name: 'New collection' }).click();
	const creator = page.getByRole('dialog', { name: 'Create collection' });
	await creator.getByLabel('Collection name').fill('Release Shelf');
	await creator.getByRole('button', { name: 'Create collection' }).click();
	await expect(page.getByRole('link', { name: 'Release Shelf' }).first()).toBeVisible();

	await page.getByRole('button', { name: 'Account menu' }).click();
	await page.getByRole('menuitem', { name: 'Sign out' }).click();
	await expect(page).toHaveURL('/login');
	await page.getByLabel('Username').fill(realAdmin.username);
	await page.getByLabel('Password').fill(realAdmin.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
	await expect(page.getByRole('link', { name: 'Admin', exact: true })).toBeVisible();
});
