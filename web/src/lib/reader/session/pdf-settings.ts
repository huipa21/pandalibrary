import type { JsonValue } from '#lib/api/client.js';
import type { ReaderSettings } from '../types.js';
import { mergeBookSettings } from '../settings.js';

type JsonObject = { [key: string]: JsonValue };

export function pdfSettingsForScope(original: JsonObject, settings: ReaderSettings, scope: 'book' | 'format'): JsonObject {
	const value = mergeBookSettings(original, settings);
	for (const key of ['font', 'size', 'spacing', 'flow']) {
		if (original[key] === undefined) delete value[key];
		else value[key] = original[key];
	}
	if (scope === 'format') {
		delete value.pdfRotation;
		if (typeof settings.pdfZoom === 'number') {
			if (original.pdfZoom === undefined) delete value.pdfZoom;
			else value.pdfZoom = original.pdfZoom;
		}
	}
	return value;
}

export function initialPdfSettings(settings: ReaderSettings, book: JsonObject, format: JsonValue | undefined): ReaderSettings {
	const defaults = typeof format === 'object' && format !== null && !Array.isArray(format) ? format : {};
	return {
		...settings,
		pdfRotation: book.pdfRotation === 90 || book.pdfRotation === 180 || book.pdfRotation === 270 ? book.pdfRotation : 0,
		pdfLayout: book.pdfLayout === undefined && defaults.pdfLayout === undefined ? 'single-continuous' : settings.pdfLayout,
		pdfZoom: book.pdfZoom === undefined && typeof book.size === 'number' && book.size !== 100
			? book.size / 100
			: book.pdfZoom === undefined && defaults.pdfZoom === undefined ? 'auto' : settings.pdfZoom
	};
}
