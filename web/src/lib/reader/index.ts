import { readerFormat, type Reader, type ReaderEvents, type ReaderFormat } from './types.js';

export async function createReader(
	format: ReaderFormat,
	container: HTMLElement,
	events: ReaderEvents
): Promise<Reader> {
	if (format === 'pdf') {
		const { PdfReader } = await import('./pdf.js');
		return new PdfReader(container, events);
	}
	const { FoliateReader } = await import('./foliate.js');
	return new FoliateReader(container, format, events);
}

export { readerFormat };
