import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { renderThumbnail } from './thumbnail-renderer.js';

class MockOffscreenCanvas {
	width: number;
	height: number;

	constructor(width: number, height: number) {
		this.width = width;
		this.height = height;
	}

	getContext() {
		return {} as OffscreenCanvasRenderingContext2D;
	}

	transferToImageBitmap() {
		return { width: this.width, height: this.height, close: vi.fn() } as unknown as ImageBitmap;
	}
}

afterEach(() => vi.unstubAllGlobals());

describe('renderThumbnail', () => {
	it('uses the requested width, DPR, rotation, and OffscreenCanvas', async () => {
		vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);
		const pdfPage = {
			getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 200 * scale, height: 300 * scale })),
			render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
		} as unknown as PDFPageProxy;
		const pdf = { numPages: 1, getPage: vi.fn(async () => pdfPage) } as unknown as PDFDocumentProxy;
		const bitmap = await renderThumbnail(pdf, 1, {
			width: 160, rotation: 90, dpr: 2, signal: new AbortController().signal
		});

		expect(pdfPage.getViewport).toHaveBeenNthCalledWith(1, { scale: 1, rotation: 90 });
		expect(pdfPage.getViewport).toHaveBeenNthCalledWith(2, { scale: 1.6, rotation: 90 });
		expect(pdfPage.render).toHaveBeenCalledOnce();
		expect(bitmap.width).toBe(320);
		expect(bitmap.height).toBe(480);
	});

	it('cancels the PDF render task when aborted', async () => {
		vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);
		let rejectRender!: (error: unknown) => void;
		const cancel = vi.fn(() => rejectRender(new DOMException('Cancelled', 'AbortError')));
		const pdfPage = {
			getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 100 * scale, height: 150 * scale })),
			render: vi.fn(() => ({
				promise: new Promise<void>((_, reject) => { rejectRender = reject; }),
				cancel
			}))
		} as unknown as PDFPageProxy;
		const pdf = { numPages: 1, getPage: vi.fn(async () => pdfPage) } as unknown as PDFDocumentProxy;
		const controller = new AbortController();
		const result = renderThumbnail(pdf, 1, {
			width: 160, rotation: 0, dpr: 1, signal: controller.signal
		});
		await vi.waitFor(() => expect(pdfPage.render).toHaveBeenCalledOnce());

		controller.abort();

		await expect(result).rejects.toMatchObject({ name: 'AbortError' });
		expect(cancel).toHaveBeenCalledOnce();
	});
});
