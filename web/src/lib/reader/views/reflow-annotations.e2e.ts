import { expect, test, type Frame, type Page } from '@playwright/test';
import { azw3Fixture, cbzFixture, epubFixture, fb2Fixture, fbzFixture, mobiFixture } from '../fixtures';

test.use({ serviceWorkers: 'block' });

const passage = 'A passage worth highlighting.';
const timestamp = '2026-11-03T00:00:00Z';
type Row = Record<string, unknown>;
type Mutation = {
	entity: string;
	id?: string;
	op: string;
	data: Row;
	updated_at: number;
};

async function setup(page: Page, format = 'epub', bytes = epubFixture()) {
	const file = {
		id: 31, format, size_bytes: bytes.length,
		download_url: `/api/v1/books/21/files/31?v=${'a'.repeat(64)}`
	};
	const book = {
		id: 21, library_id: 1, title: 'Reflow marks fixture', sort_title: 'Reflow marks fixture',
		subtitle: null, description: null, language: 'en', publisher: null, published_date: null,
		page_count: null, cover_url: null, cover_source: null, authors: [], series: null, tags: [],
		identifiers: [], files: [file], field_sources: [], created_at: timestamp, updated_at: timestamp
	};
	const state = {
		rev: 1,
		mutations: [] as Mutation[],
		highlights: [] as Row[],
		notes: [] as Row[],
		bookmarks: [] as Row[]
	};
	await page.route('**/api/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/v1/setup') return route.fulfill({ json: { required: false } });
		if (path === '/api/v1/auth/me') {
			return route.fulfill({ json: {
				user: { id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en' }
			} });
		}
		if (path === '/api/v1/books/21') return route.fulfill({ json: { book } });
		if (path === '/api/v1/books/21/files/31') {
			return route.fulfill({ contentType: 'application/octet-stream', body: bytes });
		}
		if (path === '/api/v1/me/books/21') {
			return route.fulfill({ json: {
				user_book: null, progress: null, highlights: state.highlights, notes: state.notes,
				bookmarks: state.bookmarks, page_annotations: []
			} });
		}
		if (path === '/api/v1/me/settings') {
			return route.fulfill({ json: { settings: [
				{ key: `reader.${format}`, value: { font: 'serif' }, updated_at: timestamp, rev: 1 }
			] } });
		}
		if (path === '/api/v1/sync/pull') {
			const cursor = Number(new URL(route.request().url()).searchParams.get('cursor'));
			const newer = (row: Row) => Number(row.rev) > cursor;
			return route.fulfill({ json: {
				cursor: state.rev, user_books: [], reading_progress: [], user_settings: [],
				highlights: state.highlights.filter(newer), notes: state.notes.filter(newer),
				bookmarks: state.bookmarks.filter(newer), page_annotations: []
			} });
		}
		if (path === '/api/v1/sync/push') {
			const { mutations } = route.request().postDataJSON() as { mutations: Mutation[] };
			for (const mutation of mutations) {
				state.rev += 1;
				state.mutations.push(mutation);
				if (mutation.entity !== 'highlights' && mutation.entity !== 'notes' && mutation.entity !== 'bookmarks') continue;
				const rows = state[mutation.entity];
				const previous = rows.find((row) => row.id === mutation.id);
				const remaining = rows.filter((row) => row.id !== mutation.id);
				if (mutation.op === 'upsert') {
					remaining.push({
						...previous, ...mutation.data, id: mutation.id,
						created_at: previous?.created_at ?? new Date(mutation.updated_at).toISOString(),
						updated_at: new Date(mutation.updated_at).toISOString(), deleted_at: null, rev: state.rev
					});
				}
				state[mutation.entity] = remaining;
			}
			return route.fulfill({ json: {
				results: mutations.map((_, index) => ({ index, status: 'applied' }))
			} });
		}
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	await page.goto('/read/21/31');
	await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled();
	return state;
}

async function bookFrame(page: Page, text = passage): Promise<Frame> {
	let frame: Frame | undefined;
	await expect(async () => {
		frame = undefined;
		for (const candidate of page.frames().filter((item) => item.url().startsWith('blob:'))) {
			if (await candidate.getByText(text, { exact: true }).isVisible()) {
				frame = candidate;
				break;
			}
		}
		expect(frame).toBeDefined();
	}).toPass({ timeout: 10_000 });
	if (!frame) throw new Error('The Foliate text frame did not load.');
	return frame;
}

async function selectPassage(page: Page, text = passage) {
	const frame = await bookFrame(page);
	await frame.getByText(passage, { exact: true }).evaluate((element, selectedText) => {
		window.focus();
		const range = document.createRange();
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		let node: Node | null;
		while ((node = walker.nextNode())) {
			const offset = node.textContent?.indexOf(selectedText) ?? -1;
			if (offset < 0) continue;
			range.setStart(node, offset);
			range.setEnd(node, offset + selectedText.length);
			break;
		}
		if (!node) throw new Error(`Missing selection text: ${selectedText}`);
		const selection = document.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		document.dispatchEvent(new Event('selectionchange'));
	}, text);
	await expect(selectionToolbar(page)).toBeVisible();
	return frame;
}

const selectionToolbar = (page: Page) => page.getByRole('toolbar', { name: 'Selection actions', exact: true });
const highlights = (state: Awaited<ReturnType<typeof setup>>) =>
	state.mutations.filter((mutation) => mutation.entity === 'highlights' && mutation.op === 'upsert');

async function openAnnotations(page: Page) {
	const tab = page.getByRole('tab', { name: 'Annotations', exact: true });
	if (await tab.getAttribute('aria-selected') !== 'true') await tab.click();
	await expect(page.getByRole('tabpanel', { name: 'Annotations', exact: true })).toBeVisible();
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 360, height: 740 }]) {
	test(`EPUB mouse selection opens the shared toolbar inside the reader at ${viewport.width}px`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await setup(page);
		const frame = await bookFrame(page);
		const frameBox = await (await frame.frameElement()).boundingBox();
		if (!frameBox) throw new Error('The Foliate iframe has no bounds.');
		const rects = await frame.getByText(passage, { exact: true }).evaluate((element) => {
			const range = document.createRange();
			range.selectNodeContents(element);
			return [...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => ({
				x: rect.x, y: rect.y, width: rect.width, height: rect.height
			}));
		});
		expect(rects.length).toBeGreaterThan(0);
		const first = rects[0];
		const last = rects.at(-1)!;
		await page.mouse.move(frameBox.x + first.x + 1, frameBox.y + first.y + first.height / 2);
		await page.mouse.down();
		await page.mouse.move(frameBox.x + last.x + last.width - 1, frameBox.y + last.y + last.height / 2, { steps: 12 });
		await page.mouse.up();
		await expect.poll(() => frame.evaluate(() => document.getSelection()?.toString().trim())).toContain('passage worth');

		const toolbar = selectionToolbar(page);
		await expect(toolbar).toBeVisible();
		await expect(toolbar).toHaveAttribute('data-testid', 'pv8-selection-toolbar');
		for (const name of ['Copy', 'Highlight', 'Highlight colors', 'Underline', 'Strikeout', 'Line colors', 'Comment', 'Bookmark']) {
			await expect(toolbar.getByRole('button', { name, exact: true })).toBeVisible();
		}
		await expect(async () => {
			const bar = await toolbar.boundingBox();
			const surface = await page.locator('#reader-surface').boundingBox();
			if (!bar || !surface) throw new Error('Missing reader or toolbar bounds.');
			expect(bar.x).toBeGreaterThanOrEqual(surface.x);
			expect(bar.y).toBeGreaterThanOrEqual(surface.y);
			expect(bar.x + bar.width).toBeLessThanOrEqual(Math.min(surface.x + surface.width, viewport.width));
			expect(bar.y + bar.height).toBeLessThanOrEqual(Math.min(surface.y + surface.height, viewport.height));
		}).toPass();
	});
}

test('EPUB toolbar saves three CFI mark styles and remembers independent palette colors', async ({ page }) => {
	const state = await setup(page);
	await selectPassage(page);
	await selectionToolbar(page).getByRole('button', { name: 'Highlight colors', exact: true }).click();
	await page.getByRole('radio', { name: 'Blue', exact: true }).click();
	await expect.poll(() => highlights(state).length).toBe(1);
	expect(highlights(state)[0].data).toMatchObject({
		book_id: 21, book_file_id: 31, text: passage, color: 'blue', style: 'highlight',
		locator: { type: 'cfi', value: expect.stringMatching(/^epubcfi\(.+,.+,.+\)$/) }
	});
	const locator = highlights(state)[0].data.locator;
	await expect(selectionToolbar(page)).toHaveCount(0);

	await selectPassage(page, 'worth');
	await selectionToolbar(page).getByRole('button', { name: 'Line colors', exact: true }).click();
	await page.getByRole('radio', { name: 'Cyan', exact: true }).click();
	await expect(selectionToolbar(page)).toBeVisible();
	expect(highlights(state)).toHaveLength(1);
	for (const [label, style, text] of [
		['Underline', 'underline', 'worth'], ['Strikeout', 'strikeout', 'highlighting.']
	] as const) {
		if (style === 'strikeout') await selectPassage(page, text);
		await selectionToolbar(page).getByRole('button', { name: label, exact: true }).click();
		await expect.poll(() => highlights(state).at(-1)?.data.style).toBe(style);
		expect(highlights(state).at(-1)?.data).toMatchObject({
			text, color: '#22d3ee', style,
			locator: { type: 'cfi', value: expect.stringMatching(/^epubcfi\(.+,.+,.+\)$/) }
		});
		expect(highlights(state).at(-1)?.data.locator).not.toEqual(locator);
		await expect(selectionToolbar(page)).toHaveCount(0);
	}
	expect(highlights(state)).toHaveLength(3);
	await expect.poll(() => state.highlights.length).toBe(3);
	await page.reload();
	const restoredFrame = await bookFrame(page);
	const iframe = await restoredFrame.frameElement();
	for (const [style, text, color] of [
		['highlight', passage, '#60a5fa'], ['underline', 'worth', '#22d3ee'],
		['strikeout', 'highlighting.', '#22d3ee']
	] as const) {
		// Foliate keeps the SVG beside its iframe inside a closed shadow root.
		const paintedStyle = () => iframe.evaluate((element, { style, text }) => {
			const doc = (element as HTMLIFrameElement).contentDocument!;
			const paragraph = doc.querySelector('#passage')!;
			const node = paragraph.firstChild!;
			const start = node.textContent!.indexOf(text);
			const range = doc.createRange();
			range.setStart(node, start);
			range.setEnd(node, start + text.length);
			return {
				expected: [...range.getClientRects()].map(({ x, y, width, height }) => ({ x, y, width, height })),
				groups: [...element.parentElement!.querySelectorAll(`svg [data-annotation-style="${style}"]`)].map((group) => ({
					color: group.getAttribute('fill'),
					rects: [...group.querySelectorAll('rect')].map((rect) => ({
						x: Number(rect.getAttribute('x')), y: Number(rect.getAttribute('y')),
						width: Number(rect.getAttribute('width')), height: Number(rect.getAttribute('height'))
					}))
				}))
			};
		}, { style, text });
		await expect.poll(async () => (await paintedStyle()).groups.length).toBe(1);
		const { groups, expected } = await paintedStyle();
		expect(groups[0].color).toBe(color);
		expect(expected.length).toBeGreaterThan(0);
		expect(groups[0].rects).toHaveLength(expected.length);
		for (const [index, rect] of groups[0].rects.entries()) {
			const source = expected[index];
			expect(rect.width).toBeGreaterThan(0);
			expect(rect.x).toBeCloseTo(source.x, 1);
			expect(rect.width).toBeCloseTo(source.width, 1);
			expect(rect.height).toBeCloseTo(style === 'highlight' ? source.height : 2, 1);
			const y = style === 'highlight' ? source.y
				: style === 'underline' ? source.y + source.height - 1 : source.y + source.height / 2;
			expect(rect.y).toBeCloseTo(y, 1);
		}
	}
	await selectPassage(page);
	await expect(selectionToolbar(page).locator('.pv8-split .pv8-colour-dot')).toHaveCSS('background-color', 'rgb(96, 165, 250)');
	await expect(selectionToolbar(page).locator('.pv8-line-caret .pv8-colour-dot')).toHaveCSS('background-color', 'rgb(34, 211, 238)');
	await page.keyboard.press('Escape');
	await openAnnotations(page);
	await expect(page.locator('.rp7-excerpt')).toHaveText([passage, 'worth', 'highlighting.']);
});

test('EPUB comment links a note to its selection and the sidebar highlight workflow still works', async ({ page }) => {
	const state = await setup(page);
	await selectPassage(page);
	await selectionToolbar(page).getByRole('button', { name: 'Comment', exact: true }).click();
	const sticky = page.getByRole('dialog');
	await expect(sticky).toBeVisible();
	await expect(sticky.locator('textarea')).toBeFocused();
	await expect(page.getByRole('textbox', { name: 'Note in Markdown' })).toHaveCount(0);
	await sticky.locator('textarea').fill('A **linked** EPUB comment');
	await sticky.getByRole('button', { name: 'Save note', exact: true }).click();
	await expect.poll(() => state.notes.length).toBe(1);
	await expect.poll(() => state.highlights.length).toBe(1);
	expect(state.notes[0]).toMatchObject({ highlight_id: state.highlights[0].id, body_md: 'A **linked** EPUB comment' });
	expect(state.highlights[0]).toMatchObject({ text: passage, locator: { type: 'cfi', value: expect.stringContaining('epubcfi(') } });
	await openAnnotations(page);
	const row = page.locator('.rp7-entry');
	await expect(row).toHaveCount(1);
	await expect(row.locator('.rp7-comment')).toHaveText('A **linked** EPUB comment');
	await expect(row.locator('strong')).toHaveCount(0);
	await expect(row.locator('.rp7-swatch')).toHaveCSS('background-color', 'rgb(250, 204, 21)');
	await expect(row).toHaveCSS('height', '56px');
	expect(await row.evaluate((element) => {
		const edit = element.querySelector('.rp7-edit')!;
		const remove = element.querySelector('[data-rp7-delete]')!;
		return !!(edit.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING);
	})).toBe(true);
	await row.locator('.rp7-edit').click();
	const details = page.getByRole('dialog');
	await details.getByRole('combobox', { name: 'Highlight color', exact: true }).selectOption('green');
	await expect.poll(() => state.highlights[0].color).toBe('green');
	await details.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('dialog').locator('textarea').fill('Edited **plain** comment');
	await page.getByRole('dialog').getByRole('button', { name: 'Save note', exact: true }).click();
	await expect.poll(() => state.notes[0].body_md).toBe('Edited **plain** comment');
	await page.getByRole('dialog').getByRole('button', { name: 'Close annotation details', exact: true }).click();
	await expect(row.locator('.rp7-comment')).toHaveText('Edited **plain** comment');
	await page.getByRole('searchbox', { name: 'Search annotations', exact: true }).fill('missing');
	await expect(row).toHaveCount(0);
	await page.getByRole('searchbox', { name: 'Search annotations', exact: true }).fill('plain');
	await expect(row).toHaveCount(1);
	await page.getByRole('searchbox', { name: 'Search annotations', exact: true }).fill('');
	await page.getByRole('tab', { name: 'Annotations', exact: true }).click();

	const frame = await bookFrame(page);
	const iframe = await frame.frameElement();
	await expect.poll(() => iframe.evaluate((element) =>
		element.parentElement!.querySelectorAll('[data-annotation-note]').length)).toBe(1);
	await iframe.evaluate((element) => {
		element.parentElement!.querySelector('[data-annotation-note]')!
			.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	});
	await expect(page.getByRole('dialog').locator('textarea')).toHaveValue('Edited **plain** comment');
	await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();

	await selectPassage(page);
	await openAnnotations(page);
	await page.getByRole('button', { name: 'Highlight selection', exact: true }).click();
	await expect.poll(() => state.highlights.length).toBe(2);
	await expect(page.locator('.rp7-excerpt').filter({ hasText: passage })).toHaveCount(2);
});

test('EPUB cancelling an empty toolbar comment removes its new mark but preserves existing highlights', async ({ page }) => {
	const state = await setup(page);
	await selectPassage(page);
	await selectionToolbar(page).getByRole('button', { name: 'Highlight', exact: true }).click();
	await expect.poll(() => state.highlights.length).toBe(1);
	const original = state.highlights[0].id;
	await selectPassage(page);
	await selectionToolbar(page).getByRole('button', { name: 'Comment', exact: true }).click();
	await expect.poll(() => state.highlights.length).toBe(2);
	await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect.poll(() => state.highlights.length).toBe(1);
	expect(state.highlights[0].id).toBe(original);
	await expect.poll(() => state.mutations.filter((mutation) => mutation.entity === 'highlights' && mutation.op === 'delete').length).toBe(1);
});

test('EPUB copy preserves selection, native collapse retains sidebar highlight, and Escape dismisses', async ({ page, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	const state = await setup(page);
	const frame = await selectPassage(page);
	await selectionToolbar(page).getByRole('button', { name: 'Copy', exact: true }).click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(passage);
	await expect.poll(() => frame.evaluate(() => document.getSelection()?.toString())).toBe(passage);
	await expect(selectionToolbar(page)).toBeVisible();
	await frame.evaluate(() => {
		document.getSelection()?.collapseToStart();
	});
	await expect(selectionToolbar(page)).toHaveCount(0);
	await openAnnotations(page);
	await page.getByRole('button', { name: 'Highlight selection', exact: true }).click();
	await expect.poll(() => state.highlights.length).toBe(1);
	expect(state.highlights[0]).toMatchObject({ text: passage, style: 'highlight' });
	await page.getByRole('tab', { name: 'Annotations', exact: true }).click();

	await selectPassage(page);
	await page.keyboard.press('Escape');
	await expect(selectionToolbar(page)).toHaveCount(0);
	expect(highlights(state)).toHaveLength(1);

	await selectPassage(page);
	await selectionToolbar(page).getByRole('button', { name: 'Bookmark', exact: true }).click();
	await expect.poll(() => state.bookmarks.length).toBe(1);
	expect(state.bookmarks[0]).toMatchObject({
		label: passage, book_file_id: 31,
		locator: { type: 'cfi', value: expect.stringMatching(/^epubcfi\(.+,.+,.+\)$/) }
	});
	await expect(selectionToolbar(page)).toHaveCount(0);
});

test('EPUB element-boundary selections paint their saved highlight before and after reload', async ({ page }) => {
	const state = await setup(page);
	let frame = await bookFrame(page);
	await frame.getByText(passage, { exact: true }).evaluate((element) => {
		window.focus();
		const range = document.createRange();
		range.selectNodeContents(element);
		const selection = document.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	});
	await expect(selectionToolbar(page)).toBeVisible();
	await selectionToolbar(page).getByRole('button', { name: 'Highlight', exact: true }).click();
	await expect.poll(() => state.highlights.length).toBe(1);
	expect(state.highlights[0]).toMatchObject({
		text: passage, style: 'highlight', color: 'yellow', locator: { type: 'cfi', value: expect.stringContaining('epubcfi(') }
	});
	for (const reload of [false, true]) {
		if (reload) {
			await page.reload();
			frame = await bookFrame(page);
		}
		const iframe = await frame.frameElement();
		await expect(async () => {
			const { expected, painted } = await iframe.evaluate((element) => {
				const doc = (element as HTMLIFrameElement).contentDocument!;
				const range = doc.createRange();
				range.selectNodeContents(doc.querySelector('#passage')!);
				const rects = (items: Iterable<DOMRect>) =>
					[...items].map(({ x, y, width, height }) => ({ x, y, width, height }));
				return {
					expected: rects(range.getClientRects()),
					painted: [...element.parentElement!.querySelectorAll('svg [data-annotation-style="highlight"]')].map((group) => ({
						color: group.getAttribute('fill'),
						rects: [...group.querySelectorAll('rect')].map((rect) => ({
							x: Number(rect.getAttribute('x')), y: Number(rect.getAttribute('y')),
							width: Number(rect.getAttribute('width')), height: Number(rect.getAttribute('height'))
						}))
					}))
				};
			});
			expect(painted).toHaveLength(1);
			expect(expected.length).toBeGreaterThan(0);
			expect(painted[0].color).toBe('#facc15');
			expect(painted[0].rects).toEqual(expected);
			expect(painted[0].rects.every((rect) => rect.width > 0 && rect.height > 0)).toBe(true);
		}).toPass();
	}
});

for (const [format, fixture] of [
	['mobi', mobiFixture], ['azw3', azw3Fixture], ['fb2', fb2Fixture], ['fbz', fbzFixture]
] as const) {
	test(`${format.toUpperCase()} uses the same toolbar and persists an underline with a CFI locator`, async ({ page }) => {
		const state = await setup(page, format, fixture());
		await selectPassage(page);
		await selectionToolbar(page).getByRole('button', { name: 'Underline', exact: true }).click();
		await expect.poll(() => state.highlights.length).toBe(1);
		expect(state.highlights[0]).toMatchObject({
			text: passage, style: 'underline', color: '#000000',
			locator: { type: 'cfi', value: expect.stringMatching(/^epubcfi\(.+,.+,.+\)$/) }
		});
		await expect(selectionToolbar(page)).toHaveCount(0);
	});
}

test('CBZ retains the sidebar page-mark action without a text-selection toolbar', async ({ page }) => {
	const state = await setup(page, 'cbz', cbzFixture());
	await openAnnotations(page);
	await page.getByRole('button', { name: 'Highlight current page', exact: true }).click();
	await expect.poll(() => state.highlights.length).toBe(1);
	expect(state.highlights[0]).toMatchObject({
		book_file_id: 31, style: 'highlight', locator: { type: 'cfi', value: expect.stringContaining('epubcfi(') }
	});
	await expect(selectionToolbar(page)).toHaveCount(0);
	await page.reload();
	await openAnnotations(page);
	await expect(page.locator('.rp7-excerpt')).toHaveText('Highlight');
});
