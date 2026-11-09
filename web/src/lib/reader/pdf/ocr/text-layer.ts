import type { OcrPage, OcrWord } from './types.js';

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function joinOcrWords(words: Pick<OcrWord, 'text'>[]): string {
	return words.map((word) => word.text.trim()).filter(Boolean).reduce((text, word) => {
		if (!text) return word;
		const last = Array.from(text).at(-1)!;
		return text + (CJK.test(last) && CJK.test(Array.from(word)[0]) ? '' : ' ') + word;
	}, '');
}

export function buildOcrTextLayer(overlay: HTMLElement, page: OcrPage, signal?: AbortSignal): () => void {
	signal?.throwIfAborted();
	const layer = document.createElement('div');
	layer.className = 'pv-ocr-text textLayer reader-pdf-text';
	Object.assign(layer.style, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'auto', userSelect: 'text', lineHeight: '1' });
	const spans = page.lines.map((line) => {
		const span = document.createElement('span');
		span.textContent = (line.words.length ? joinOcrWords(line.words) : line.text) + '\n';
		Object.assign(span.style, {
			position: 'absolute', color: 'transparent', whiteSpace: 'pre', cursor: 'text',
			left: `${line.box.x * 100}%`, top: `${line.box.y * 100}%`,
			width: `${line.box.width * 100}%`, height: `${line.box.height * 100}%`,
			transformOrigin: '0 0', fontFamily: 'sans-serif'
		});
		layer.append(span);
		return span;
	});
	overlay.append(layer);
	const measure = document.createElement('canvas').getContext('2d');
	if (!measure) {
		layer.remove();
		throw new Error('OCR text measurement is unavailable.');
	}
	function resize() {
		for (const [index, span] of spans.entries()) {
			const line = page.lines[index];
			const size = line.box.height * overlay.clientHeight;
			span.style.fontSize = `${size}px`;
			measure!.font = `${size}px sans-serif`;
			const width = measure!.measureText(span.textContent?.trimEnd() ?? '').width;
			span.style.transform = `scaleX(${width > 0 ? line.box.width * overlay.clientWidth / width : 1})`;
			// Width is the pre-transform box; its transformed width is the line box.
			if (width > 0 && overlay.clientWidth) span.style.width = `${width / overlay.clientWidth * 100}%`;
		}
	}
	const observer = new ResizeObserver(resize);
	observer.observe(overlay);
	resize();
	const cleanup = () => {
		observer.disconnect();
		layer.remove();
		signal?.removeEventListener('abort', cleanup);
	};
	signal?.addEventListener('abort', cleanup, { once: true });
	return cleanup;
}
