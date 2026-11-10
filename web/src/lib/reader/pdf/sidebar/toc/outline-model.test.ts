import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterEach, describe, expect, it } from 'vitest';
import {
	currentNode,
	flattenOutline,
	loadOutline,
	outlineTitle,
	safeOutlineUrl,
	type OutlineNode
} from './outline-model';
import { outlinePdfFixture } from './outline-fixture';
import { pdfFixture } from '../../../fixtures';

const tasks: { destroy(): Promise<void> }[] = [];

async function openPdf(data: Buffer) {
	const task = getDocument({ data: new Uint8Array(data) });
	tasks.push(task);
	return task.promise;
}

afterEach(async () => {
	await Promise.all(tasks.splice(0).map((task) => task.destroy()));
});

function node(id: string, page: number | null, offset: number, depth: number): OutlineNode {
	return { id, title: id, depth, page, offset, url: null, children: [] };
}

describe('outline model', () => {
	it('resolves named, explicit and XYZ destinations and marks broken destinations unresolved', async () => {
		const pdf = await openPdf(outlinePdfFixture());
		const outline = await loadOutline(pdf);

		expect(outline.map((entry) => entry.title)).toEqual(['Part One', 'Part Two', 'Unresolved', 'Project site']);
		expect(outline[0]).toMatchObject({ page: 1, offset: 0 });
		expect(outline[0].children).toMatchObject([
			{ title: 'Opening', page: 1, offset: 0 },
			{ title: 'Middle', page: 2, offset: 0.5 }
		]);
		expect(outline[1]).toMatchObject({ page: 3, offset: 0 });
		expect(outline[2]).toMatchObject({ page: null, offset: 0 });
		expect(outline[3]).toMatchObject({ page: null, url: 'https://example.test/contents' });
	});

	it('returns an empty outline and reuses the result for a document fingerprint', async () => {
		const pdf = await openPdf(pdfFixture());
		const first = await loadOutline(pdf);
		const second = await loadOutline(pdf);

		expect(first).toEqual([]);
		expect(second).toBe(first);
	});

	it('rejects an already-aborted request', async () => {
		const pdf = await openPdf(outlinePdfFixture());
		const controller = new AbortController();
		controller.abort();

		await expect(loadOutline(pdf, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('trims, falls back, and caps titles', () => {
		expect(outlineTitle('  Chapter 1  ')).toBe('Chapter 1');
		expect(outlineTitle('  ')).toBe('Untitled');
		expect(outlineTitle('x'.repeat(301))).toHaveLength(300);
	});

	it('keeps only safe external URL schemes', () => {
		expect(safeOutlineUrl('https://example.test')).toBe('https://example.test');
		expect(safeOutlineUrl('mailto:reader@example.test')).toBe('mailto:reader@example.test');
		expect(safeOutlineUrl('javascript:alert(1)')).toBeNull();
		expect(safeOutlineUrl('data:text/html,unsafe')).toBeNull();
		expect(safeOutlineUrl('/relative')).toBeNull();
		expect(safeOutlineUrl('not a URL')).toBeNull();
	});

	it('chooses the latest eligible location and breaks ties by depth', () => {
		const flat = [
			node('deep-tie', 2, 0.4, 2),
			node('later-shallow', 2, 0.7, 0),
			node('start', 1, 0, 0),
			node('tie', 2, 0.4, 1),
			node('future', 3, 0, 0),
			node('unresolved', null, 0, 3)
		];

		expect(currentNode(flat, 2, 0.39)?.id).toBe('start');
		expect(currentNode(flat, 2, 0.4)?.id).toBe('deep-tie');
		expect(currentNode(flat, 2, 0.69)?.id).toBe('deep-tie');
		expect(currentNode(flat, 2, 0.7)?.id).toBe('later-shallow');
		expect(currentNode(flat, 1, 0)?.id).toBe('start');
		expect(currentNode(flat, 1, -0.01)).toBeNull();
	});

	it('flattens the tree in document order with parent relationships', () => {
		const tree = [node('one', 1, 0, 0)];
		tree[0].children.push(node('one.two', 2, 0, 1));

		expect(flattenOutline(tree).map(({ id, parentId, depth }) => ({ id, parentId, depth }))).toEqual([
			{ id: 'one', parentId: null, depth: 0 },
			{ id: 'one.two', parentId: 'one', depth: 1 }
		]);
	});
});
