import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

export interface ThumbnailOptions {
	width: number;
	rotation: number;
	dpr: number;
	signal: AbortSignal;
}

type ThumbnailDocument = Pick<PDFDocumentProxy, 'getPage' | 'numPages'>;
type RenderablePage = Pick<PDFPageProxy, 'getViewport' | 'render'>;

function abortError(): DOMException {
	return new DOMException('The thumbnail render was aborted.', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortError();
}

export async function renderThumbnail(
	pdf: ThumbnailDocument,
	pageNumber: number,
	{ width, rotation, dpr, signal }: ThumbnailOptions
): Promise<ImageBitmap> {
	if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) {
		throw new RangeError(`Invalid PDF page number: ${pageNumber}`);
	}
	if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(dpr) || dpr <= 0) {
		throw new RangeError('Thumbnail width and device-pixel ratio must be positive.');
	}
	throwIfAborted(signal);

	let pdfPage: RenderablePage;
	try {
		pdfPage = await pdf.getPage(pageNumber);
	} catch (error) {
		throwIfAborted(signal);
		throw error;
	}
	throwIfAborted(signal);

	const natural = pdfPage.getViewport({ scale: 1, rotation });
	const viewport = pdfPage.getViewport({ scale: (width * dpr) / natural.width, rotation });
	const useOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';
	const canvas = useOffscreenCanvas
		? new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
		: document.createElement('canvas');
	canvas.width = Math.ceil(viewport.width);
	canvas.height = Math.ceil(viewport.height);
	const context = canvas.getContext('2d');
	if (!context) throw new Error('A 2D canvas context is unavailable for the PDF thumbnail.');

	const task = pdfPage.render({
		canvas: null,
		canvasContext: context as CanvasRenderingContext2D,
		viewport
	});
	const cancel = () => task.cancel();
	signal.addEventListener('abort', cancel, { once: true });
	try {
		await task.promise;
		throwIfAborted(signal);
		return useOffscreenCanvas
			? (canvas as OffscreenCanvas).transferToImageBitmap()
			: await createImageBitmap(canvas as HTMLCanvasElement);
	} catch (error) {
		throwIfAborted(signal);
		throw error;
	} finally {
		signal.removeEventListener('abort', cancel);
	}
}
