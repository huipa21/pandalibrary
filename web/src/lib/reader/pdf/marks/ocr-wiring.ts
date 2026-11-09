import { ocrLanguagesFor } from '../ocr/languages.js';
import type { OcrStatus } from '../ocr/status.js';
import type { PdfReaderContext, PdfTool } from '../context.js';

export interface OcrWiring {
	/** Call whenever the OCR switch or the tool changes. */
	update(enabled: boolean, tool: PdfTool): void;
	dispose(): void;
}

/** Whether a switch/tool change must re-run the page enhancers. */
export function ocrNeedsRerun(previous: { enabled: boolean; tool: PdfTool }, next: { enabled: boolean; tool: PdfTool }): boolean {
	if (previous.enabled !== next.enabled) return true;
	return next.enabled && next.tool === 'select' && previous.tool !== 'select';
}

/**
 * Registers the scanned-page OCR enhancer with the engine. It only runs in the Select tool and while the
 * PV5 switch is on; turning the switch off re-runs the enhancers, which aborts and removes OCR layers.
 */
export function wireOcr(context: PdfReaderContext, onStatus: (status: OcrStatus) => void): OcrWiring {
	const engine = context.engine;
	let disposed = false;
	let state = { enabled: context.ocr.enabled, tool: context.tool.current };
	let release: (() => void) | undefined;
	let dispose: (() => Promise<void>) | undefined;
	// Loaded lazily so reading true-text PDFs never pulls in the OCR runtime.
	void import('../ocr/enhancer.js').then(({ createOcrEnhancer }) => {
		if (disposed) return;
		const enhancer = createOcrEnhancer({
			enabled: () => context.ocr.enabled,
			active: () => !disposed && context.tool.current === 'select',
			languages: () => ocrLanguagesFor(context.bookLanguage),
			fingerprint: () => engine.fingerprint() || `book-file:${context.controller.file?.id ?? 'unknown'}`,
			visiblePage: () => engine.state.page,
			onStatus: (status) => { if (!disposed) onStatus(status); }
		});
		dispose = enhancer.dispose;
		release = engine.addPageEnhancer(enhancer);
	}).catch((error: unknown) => console.error('Could not load scanned-page recognition', error));

	return {
		update(enabled, tool) {
			const next = { enabled, tool };
			const rerun = ocrNeedsRerun(state, next);
			state = next;
			if (rerun && release && !disposed) engine.rerunEnhancers();
		},
		dispose() {
			disposed = true;
			release?.();
			void dispose?.();
		}
	};
}
