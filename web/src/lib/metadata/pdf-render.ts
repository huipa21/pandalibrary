/** The server normalizes covers to a 1200 px long edge; rendering larger wastes memory. */
export const PDF_COVER_MAX_EDGE = 1200;
export const PDF_COVER_MAX_SCALE = 4;
export const PDF_COVER_QUALITY = 0.85;

export interface RenderSize {
	readonly scale: number;
	readonly width: number;
	readonly height: number;
}

/** Fits a page into a bounded long edge without upscaling tiny pages excessively. */
export function coverRenderSize(width: number, height: number, maxEdge = PDF_COVER_MAX_EDGE): RenderSize {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		throw new Error('The PDF page has invalid dimensions.');
	}
	const scale = Math.min(maxEdge / Math.max(width, height), PDF_COVER_MAX_SCALE);
	return {
		scale,
		width: Math.max(1, Math.min(maxEdge, Math.floor(width * scale))),
		height: Math.max(1, Math.min(maxEdge, Math.floor(height * scale)))
	};
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the cover.'))), type, quality);
	});
}

/** Renders only the first page of a PDF to a bounded JPEG using the reader's PDF.js setup. */
export async function renderPdfFirstPage(pdf: Blob, maxEdge = PDF_COVER_MAX_EDGE): Promise<Blob> {
	const [pdfjs, worker, { PdfBinaryDataFactory }, data] = await Promise.all([
		import('pdfjs-dist'),
		import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
		import('#lib/reader/pdf/binary-data.js'),
		pdf.arrayBuffer()
	]);
	pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
	const task = pdfjs.getDocument({
		data: new Uint8Array(data),
		BinaryDataFactory: PdfBinaryDataFactory,
		useWorkerFetch: false,
		enableXfa: false
	});
	const canvas = document.createElement('canvas');
	try {
		const document = await task.promise;
		const page = await document.getPage(1);
		const natural = page.getViewport({ scale: 1 });
		const size = coverRenderSize(natural.width, natural.height, maxEdge);
		const viewport = page.getViewport({ scale: size.scale });
		canvas.width = size.width;
		canvas.height = size.height;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Canvas rendering is unavailable.');
		context.fillStyle = '#ffffff';
		context.fillRect(0, 0, canvas.width, canvas.height);
		await page.render({ canvas, canvasContext: context, viewport }).promise;
		page.cleanup();
		return await canvasBlob(canvas, 'image/jpeg', PDF_COVER_QUALITY);
	} finally {
		canvas.width = 0;
		canvas.height = 0;
		await task.destroy();
	}
}
