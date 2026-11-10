import * as m from '#lib/paraglide/messages.js';
import { MARK_PRESETS, resolveMarkColor } from '../../../annotations.js';
import type { HighlightStyle } from '../../../types.js';
import type { AnnotationEntry } from './annotations-list.js';

export function styleLabel(style: HighlightStyle): string {
	switch (style) {
		case 'highlight': return m['pv10.highlight']();
		case 'underline': return m['pv10.underline']();
		case 'strikeout': return m['pv10.strikeout']();
	}
}

export function entryLabel(entry: AnnotationEntry): string {
	switch (entry.kind) {
		case 'mark': return styleLabel(entry.swatch.style);
		case 'text': return m['pv10.text']();
		case 'ink': return m['pv10.drawing']();
		case 'image': return m['pv10.image']();
	}
}

export function markColorName(value: string): string {
	const hex = resolveMarkColor(value);
	const preset = MARK_PRESETS.find((item) => resolveMarkColor(item.value) === hex);
	return preset ? m[preset.name]() : hex;
}
