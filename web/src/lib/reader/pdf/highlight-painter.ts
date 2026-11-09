import { HIGHLIGHT_HEX, highlightColor } from '../annotations.js';
import { isPdfLocator, type ReaderAnnotation } from '../types.js';
import type { PageLayerPainter } from './types.js';

/** Paints `addAnnotation` highlights (marks) until PV8 replaces the painter by name. */
export function highlightPainter(annotations: () => Iterable<ReaderAnnotation>): PageLayerPainter {
	return {
		name: 'highlight',
		z: 3,
		paint({ page, layer, toCss }) {
			for (const annotation of annotations()) {
				const locator = annotation.locator;
				if (!isPdfLocator(locator) || locator.page !== page) continue;
				for (const rect of locator.rects ?? []) {
					const mark = document.createElement('span');
					mark.className = 'reader-pdf-highlight';
					mark.dataset.annotationId = annotation.id;
					mark.dataset.style = annotation.style ?? 'highlight';
					Object.assign(mark.style, toCss(rect));
					mark.style.setProperty('--pv-mark', HIGHLIGHT_HEX[highlightColor(annotation.color)]);
					layer.append(mark);
				}
			}
		}
	};
}
