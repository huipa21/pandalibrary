import { markInk, resolveMarkColor } from '../../annotations.js';
import type { HighlightStyle } from '../../types.js';

type Tone = 'light' | 'dark';

export function readerTone(element: Element): Tone {
	const reader = element.closest('.reader-pdf');
	const tone = reader?.getAttribute('data-tone') ?? reader?.getAttribute('data-theme');
	return tone === 'dark' ? 'dark' : 'light';
}

export function paintMarkColor(element: HTMLElement, color: string, style: HighlightStyle, tone: Tone): void {
	const hex = resolveMarkColor(color);
	element.dataset.markColor = hex;
	element.style.setProperty('--pv-mark', style === 'highlight' ? hex : markInk(hex, tone));
	element.style.opacity = style === 'highlight' ? '0.35' : '1';
	element.style.mixBlendMode = style === 'highlight' ? (tone === 'dark' ? 'screen' : 'multiply') : 'normal';
}

export function observeMarkTone(viewport?: () => HTMLElement) {
	let reader: Element | null = null;
	let observer: MutationObserver | undefined;
	return {
		watch(layer: HTMLElement): Tone {
			const next = layer.closest('.reader-pdf') ?? viewport?.().closest('.reader-pdf') ?? null;
			if (!next) return reader ? readerTone(reader) : 'light';
			if (next === reader) return readerTone(next);
			observer?.disconnect();
			reader = next;
			observer = new MutationObserver(() => {
				if (!reader) return;
				const tone = readerTone(reader);
				for (const element of reader.querySelectorAll<HTMLElement>('.pv-layer[data-layer="highlight"] .reader-pdf-highlight')) {
					const style = element.dataset.style;
					if (style === 'highlight' || style === 'underline' || style === 'strikeout') {
						paintMarkColor(element, element.dataset.markColor ?? '', style, tone);
					}
				}
			});
			observer.observe(reader, { attributes: true, attributeFilter: ['data-tone', 'data-theme'] });
			return readerTone(reader);
		},
		dispose() {
			observer?.disconnect();
			observer = undefined;
			reader = null;
		}
	};
}
