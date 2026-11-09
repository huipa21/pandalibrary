import { readerFormat, type Reader, type ReaderEvents, type ReaderFormat } from './types.js';

export async function createReader(
	format: ReaderFormat,
	container: HTMLElement,
	events: ReaderEvents
): Promise<Reader> {
	if (format === 'pdf') {
		const { PdfViewerEngine } = await import('./pdf/engine.js');
		return new PdfViewerEngine(container, events);
	}
	const { FoliateReader } = await import('./foliate.js');
	return new FoliateReader(container, format, events);
}

export { readerFormat };
