import * as m from '#lib/paraglide/messages.js';
import type { HighlightStyle } from '../../types.js';
import type { PanelEntry } from './panel-model.js';

export function styleLabel(style: HighlightStyle): string {
	switch (style) {
		case 'highlight': return m['pv10.highlight']();
		case 'underline': return m['pv10.underline']();
		case 'strikeout': return m['pv10.strikeout']();
	}
}

export function entryLabel(entry: PanelEntry): string {
	switch (entry.kind) {
		case 'mark': return styleLabel(entry.style);
		case 'bookmark': return m['ux6.title']();
		case 'text': return m['pv10.text']();
		case 'ink': return m['pv10.drawing']();
		case 'image': return m['pv10.image']();
	}
}
