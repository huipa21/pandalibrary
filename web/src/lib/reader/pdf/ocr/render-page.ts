import type { PDFPageProxy } from 'pdfjs-dist';

export function ocrScale(width: number, height: number): number {
	return Math.min(300 / 72, 3000 / Math.max(width, height));
}

export async function renderOcrPage(page: PDFPageProxy, signal: AbortSignal): Promise<{ image: Blob; width: number; height: number }> {
	signal.throwIfAborted();
	const natural = page.getViewport({ scale: 1, rotation: 0 });
	const viewport = page.getViewport({ scale: ocrScale(natural.width, natural.height), rotation: 0 });
	const width = Math.ceil(viewport.width);
	const height = Math.ceil(viewport.height);
	// pdf.js's public RenderParameters require an HTML canvas context.
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('OCR canvas rendering is unavailable.');
	const task = page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' });
	const cancel = () => task.cancel();
	signal.addEventListener('abort', cancel, { once: true });
	try {
		await task.promise;
		signal.throwIfAborted();
		const pixels = context.getImageData(0, 0, width, height);
		for (let i = 0; i < pixels.data.length; i += 4) {
			const gray = Math.round(pixels.data[i] * 0.299 + pixels.data[i + 1] * 0.587 + pixels.data[i + 2] * 0.114);
			pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = gray;
		}
		let image: Blob;
		if (typeof OffscreenCanvas !== 'undefined') {
			const offscreen = new OffscreenCanvas(width, height);
			try {
				const gray = offscreen.getContext('2d');
				if (!gray) throw new Error('OCR grayscale rendering is unavailable.');
				gray.putImageData(pixels, 0, 0);
				image = await offscreen.convertToBlob({ type: 'image/png' });
			} finally {
				offscreen.width = offscreen.height = 0;
			}
		} else {
			context.putImageData(pixels, 0, 0);
			image = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) =>
				blob ? resolve(blob) : reject(new Error('Could not encode the OCR page.')), 'image/png'));
		}
		signal.throwIfAborted();
		return { image, width, height };
	} finally {
		signal.removeEventListener('abort', cancel);
		canvas.width = canvas.height = 0;
	}
}
