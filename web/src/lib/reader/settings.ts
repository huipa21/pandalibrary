import type { JsonValue } from '#lib/api/client.js';
import type { PdfZoom, ReaderFormat, ReaderSettings, Setting } from './types.js';

export const DEFAULT_SETTINGS: ReaderSettings = {
	font: 'serif',
	size: 100,
	spacing: 1.5,
	theme: 'light',
	flow: 'paginated',
	pdfLayout: 'single',
	pdfZoom: 'page-width',
	pdfRotation: 0,
	pdfCoverAlone: false
};

type JsonObject = { [key: string]: JsonValue };

function isObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isReaderSettings(value: ReaderSettings): boolean {
	return (
		['serif', 'sans-serif', 'system'].includes(value.font) &&
		Number.isFinite(value.size) && value.size >= 50 && value.size <= 200 &&
		Number.isFinite(value.spacing) && value.spacing >= 1 && value.spacing <= 2.5 &&
		['light', 'sepia', 'dark'].includes(value.theme) &&
		['paginated', 'scrolled'].includes(value.flow) &&
		(value.pdfLayout === undefined || ['single', 'single-continuous', 'split', 'split-continuous'].includes(value.pdfLayout)) &&
		(value.pdfZoom === undefined || validPdfZoom(value.pdfZoom)) &&
		(value.pdfRotation === undefined || [0, 90, 180, 270].includes(value.pdfRotation)) &&
		(value.pdfCoverAlone === undefined || typeof value.pdfCoverAlone === 'boolean')
	);
}

function validPdfZoom(value: JsonValue): value is PdfZoom {
	return typeof value === 'number' ? Number.isFinite(value) && value >= 0.1 && value <= 5
		: value === 'auto' || value === 'page-actual' || value === 'page-fit' || value === 'page-width';
}

function applyKnown(
	base: ReaderSettings,
	value: JsonObject
): { settings: ReaderSettings; invalid: boolean } {
	const result = { ...base };
	let invalid = false;
	if (value.font !== undefined) {
		if (value.font === 'serif' || value.font === 'sans-serif' || value.font === 'system') {
			result.font = value.font;
		} else invalid = true;
	}
	if (value.size !== undefined) {
		if (typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 50 && value.size <= 200) {
			result.size = value.size;
		} else invalid = true;
	}
	if (value.spacing !== undefined) {
		if (typeof value.spacing === 'number' && Number.isFinite(value.spacing) && value.spacing >= 1 && value.spacing <= 2.5) {
			result.spacing = value.spacing;
		} else invalid = true;
	}
	if (value.theme !== undefined) {
		if (value.theme === 'light' || value.theme === 'sepia' || value.theme === 'dark') {
			result.theme = value.theme;
		} else invalid = true;
	}
	if (value.flow !== undefined) {
		if (value.flow === 'paginated' || value.flow === 'scrolled') result.flow = value.flow;
		else invalid = true;
	}
	if (value.pdfLayout !== undefined) {
		if (value.pdfLayout === 'single' || value.pdfLayout === 'single-continuous' || value.pdfLayout === 'split' || value.pdfLayout === 'split-continuous') result.pdfLayout = value.pdfLayout;
		else invalid = true;
	}
	if (value.pdfZoom !== undefined) {
		if (validPdfZoom(value.pdfZoom)) result.pdfZoom = value.pdfZoom;
		else invalid = true;
	}
	if (value.pdfRotation !== undefined) {
		if (value.pdfRotation === 0 || value.pdfRotation === 90 || value.pdfRotation === 180 || value.pdfRotation === 270) result.pdfRotation = value.pdfRotation;
		else invalid = true;
	}
	if (value.pdfCoverAlone !== undefined) {
		if (typeof value.pdfCoverAlone === 'boolean') result.pdfCoverAlone = value.pdfCoverAlone;
		else invalid = true;
	}
	return { settings: result, invalid };
}

export function loadReaderSettings(settings: Setting[], format: ReaderFormat, bookId: number) {
	const formatValue = settings.find((setting) => setting.key === `reader.${format}`)?.value;
	const bookValue = settings.find((setting) => setting.key === `reader.book.${bookId}`)?.value;
	const formatObject = isObject(formatValue) ? formatValue : {};
	const bookObject = isObject(bookValue) ? bookValue : {};
	const defaults = applyKnown(DEFAULT_SETTINGS, formatObject);
	const overrides = applyKnown(defaults.settings, bookObject);
	return {
		settings: overrides.settings,
		bookValue: bookObject,
		canSave: bookValue === undefined || isObject(bookValue),
		invalid:
			(formatValue !== undefined && !isObject(formatValue)) ||
			(bookValue !== undefined && !isObject(bookValue)) ||
			defaults.invalid ||
			overrides.invalid
	};
}

export function mergeBookSettings(original: JsonObject, settings: ReaderSettings): JsonObject {
	if (!isReaderSettings(settings)) throw new Error('Invalid reader settings.');
	const value: JsonObject = { ...original, ...settings };
	if (new TextEncoder().encode(JSON.stringify(value)).length > 64 * 1024) {
		throw new Error('Reader settings exceed the server limit.');
	}
	return value;
}
