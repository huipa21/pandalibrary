import { expect, type Locator, type Page } from '@playwright/test';

export const pdfPageBox = (page: Page) => page.getByRole('textbox', { name: /^Page \d+ of \d+$/ });
export const pdfPageText = (page: Page, n: number) => page.locator(`.reader-pdf-page[data-page="${n}"] .reader-pdf-text`);
export const annotationsPanel = (page: Page) => page.getByRole('tabpanel', { name: 'Annotations', exact: true });
export const selectionToolbar = (page: Page) => page.getByRole('toolbar', { name: 'Selection actions', exact: true });

/** Waits for PDF controls and, when provided, the expected page text. */
export async function openedPdf(page: Page, n = 1, text?: string) {
	await expect(pdfPageBox(page)).toBeEnabled({ timeout: 30_000 });
	if (text) await expect(pdfPageText(page, n)).toContainText(text, { timeout: 30_000 });
}

export async function jumpToPdfPage(page: Page, n: number) {
	await pdfPageBox(page).fill(String(n));
	await pdfPageBox(page).press('Enter');
	await expect(pdfPageBox(page)).toHaveValue(String(n));
}

/** Selects from the start of the text item containing `from` to the end of the one containing `to`. */
export async function selectPdfText(page: Page, from: string, to = from) {
	await page.evaluate(([start, end]) => {
		const items = [...document.querySelectorAll('.reader-pdf .textLayer span')].filter((span) => !span.children.length);
		const find = (text: string) => {
			const item = items.find((span) => span.textContent?.includes(text));
			if (!item?.firstChild) throw new Error(`Missing text ${text}`);
			return item.firstChild as Text;
		};
		const first = find(start);
		const last = find(end);
		const range = document.createRange();
		range.setStart(first, 0);
		range.setEnd(last, last.length);
		const selection = document.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	}, [from, to]);
	await expect(selectionToolbar(page)).toBeVisible();
}

export async function openAnnotationsPanel(page: Page) {
	if (await annotationsPanel(page).isVisible()) return annotationsPanel(page);
	await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
	await expect(annotationsPanel(page)).toBeVisible();
	return annotationsPanel(page);
}

/** Bookmarks the selected text, then renames it in the book-wide bookmarks list. */
export async function bookmarkPdfSelection(page: Page, text: string, label: string) {
	const readerUrl = page.url();
	await selectPdfText(page, text);
	await selectionToolbar(page).getByRole('button', { name: 'Bookmark', exact: true }).click();
	await expect(selectionToolbar(page)).toHaveCount(0);
	await page.goto('/bookmarks');
	const match = page.getByRole('listitem').filter({ hasText: text }).first();
	await expect(match).toBeVisible();
	const href = await match.getByRole('link', { name: 'Open bookmark' }).getAttribute('href');
	const id = href ? new URL(href, readerUrl).searchParams.get('bookmark') : null;
	if (!id) throw new Error('The saved PDF bookmark has no ID in its link.');
	await renamePdfBookmark(match, label);
	await page.goto(readerUrl);
	await openedPdf(page);
	return id;
}

export async function renamePdfBookmark(entry: Locator, label: string) {
	const index = await entry.evaluate((element) => [...(element.parentElement?.children ?? [])].indexOf(element));
	if (index < 0) throw new Error('The PDF bookmark is not in the bookmarks list.');
	const saved = entry.page().locator('section[aria-labelledby="bookmarks-heading"] > ul > li').nth(index);
	await saved.getByRole('button', { name: 'Edit', exact: true }).click();
	await saved.getByRole('textbox').fill(label);
	await saved.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(saved).toContainText(label);
}
