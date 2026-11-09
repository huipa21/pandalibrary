import { activeViewer } from '#lib/sync/db.js';
import { OcrCache, type OcrCacheKey } from './cache.js';
import { needsOcr } from './detect.js';
import type { OcrLanguage } from './languages.js';
import { OcrQueue } from './queue.js';
import { renderOcrPage } from './render-page.js';
import type { OcrStatus } from './status.js';
import { buildOcrTextLayer } from './text-layer.js';
import type { OcrEnhancer, OcrPageContext } from './types.js';
import { OcrWorkers } from './worker.js';

export interface OcrEnhancerOptions {
	enabled: () => boolean;
	active: () => boolean;
	languages: () => readonly OcrLanguage[];
	fingerprint: () => string;
	visiblePage: () => number;
	onStatus: (status: OcrStatus) => void;
}

async function account(): Promise<number | null> {
	try {
		return (await activeViewer())?.id ?? null;
	} catch (error) {
		console.warn('Could not read the offline account; OCR results will only be kept in memory.', error);
		return null;
	}
}

export function createOcrEnhancer(options: OcrEnhancerOptions): OcrEnhancer & { dispose(): Promise<void> } {
	const queue = new OcrQueue();
	const workers = new OcrWorkers();
	const cache = new OcrCache();
	const lifetime = new AbortController();
	const statuses = new Map<number, OcrStatus>();
	const update = (page: number, status: OcrStatus) => {
		if (lifetime.signal.aborted) return;
		if (status.state === 'idle') statuses.delete(page);
		else statuses.set(page, status);
		const nearest = [...statuses].sort(([a], [b]) =>
			Math.abs(a - options.visiblePage()) - Math.abs(b - options.visiblePage()))[0];
		options.onStatus(nearest?.[1] ?? { state: 'idle' });
	};

	const enhance: OcrEnhancer = async (context: OcrPageContext) => {
		if (!options.enabled() || !options.active() || !needsOcr(context) || lifetime.signal.aborted || context.signal.aborted) return;
		const signal = AbortSignal.any([context.signal, lifetime.signal]);
		const valid = () => !signal.aborted && options.enabled() && options.active();
		context.pageDiv.dataset.scanned = 'true';
		const clear = () => update(context.page, { state: 'idle' });
		signal.addEventListener('abort', clear, { once: true });
		try {
			const accountId = await account();
			if (!valid()) return;
			const key: OcrCacheKey = {
				accountId, fingerprint: options.fingerprint(), page: context.page, languages: [...options.languages()]
			};
			let page = await cache.get(key, signal);
			if (!valid()) return;
			if (!page) {
				page = await queue.enqueue(() => Math.abs(context.page - options.visiblePage()), signal, async () => {
					if (!valid()) throw new DOMException('OCR cancelled.', 'AbortError');
					const rendered = await renderOcrPage(context.pdfPage, signal);
					const result = await workers.recognize(
						rendered.image, rendered.width, rendered.height, key.languages,
						context.page, signal, (status) => update(context.page, status)
					);
					if (!valid() || await account() !== accountId) throw new DOMException('OCR account changed.', 'AbortError');
					signal.throwIfAborted();
					await cache.put(key, result, signal);
					return result;
				});
			}
			if (!valid() || await account() !== accountId) {
				clear();
				return;
			}
			signal.throwIfAborted();
			buildOcrTextLayer(context.overlay, page, signal);
			clear();
		} catch (error) {
			if (signal.aborted || error instanceof DOMException && error.name === 'AbortError') {
				clear();
				return;
			}
			update(context.page, {
				state: 'error', page: context.page, error,
				retry: () => {
					if (!valid()) return;
					clear();
					void enhance(context);
				}
			});
		}
	};
	return Object.assign(enhance, {
		async dispose() {
			lifetime.abort();
			queue.dispose();
			cache.dispose();
			await workers.dispose();
			options.onStatus({ state: 'idle' });
		}
	});
}
