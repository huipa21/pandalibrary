import { describe, expect, it, vi } from 'vitest';
import type { FoliateBook } from 'foliate-js/view.js';
import { captureBookBlobs, isolateBookSections } from './safe-content.js';

describe('Foliate section isolation', () => {
	it('captures HTML blobs without a fetch and restores the native URL API after overlapping loads', async () => {
		const nativeCreate = URL.createObjectURL;
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const firstBlob = new Blob(['<p>First</p>'], { type: 'text/html' });
		const secondBlob = new Blob(['<p>Second</p>'], { type: 'application/xhtml+xml' });
		const first = captureBookBlobs(async () => {
			const url = URL.createObjectURL(firstBlob);
			await gate;
			return url;
		});
		const second = await captureBookBlobs(() => URL.createObjectURL(secondBlob));
		expect(second.blobs.get(second.value)).toBe(secondBlob);
		expect(URL.createObjectURL).not.toBe(nativeCreate);
		release();
		const result = await first;
		expect(result.blobs.get(result.value)).toBe(firstBlob);
		expect(URL.createObjectURL).toBe(nativeCreate);
		URL.revokeObjectURL(result.value);
		URL.revokeObjectURL(second.value);
	});

	it('restores URL creation when an upstream load fails', async () => {
		const nativeCreate = URL.createObjectURL;
		await expect(captureBookBlobs(() => { throw new Error('Bad archive'); })).rejects.toThrow('Bad archive');
		expect(URL.createObjectURL).toBe(nativeCreate);
	});

	it('preserves non-linear placeholder indices but rejects unreadable linear sections', () => {
		const book: FoliateBook = { sections: [{ linear: 'no' }] };
		isolateBookSections(book, new Map(), vi.fn());
		expect(book.sections).toHaveLength(1);
		expect(book.sections[0].load).toBeUndefined();
		expect(() => isolateBookSections({ sections: [{}] }, new Map(), vi.fn())).toThrow('unreadable section');
		book.destroy?.();
	});
});
