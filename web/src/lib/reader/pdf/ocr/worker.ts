import type { Bbox, Page, Worker } from 'tesseract.js';
import base from 'virtual:ocr-assets';
import { languageKey, type OcrLanguage } from './languages.js';
import type { OcrPage } from './types.js';
import type { OcrStatus } from './status.js';

interface Slot {
	key: string;
	worker: Worker;
	busy: boolean;
	progress: (message: { status: string; progress: number }) => void;
	timer?: ReturnType<typeof setTimeout>;
}

export function ocrResult(data: Pick<Page, 'blocks'>, width: number, height: number): OcrPage {
	const box = ({ x0, y0, x1, y1 }: Bbox) => ({
		x: Math.max(0, Math.min(1, x0 / width)),
		y: Math.max(0, Math.min(1, y0 / height)),
		width: Math.max(0, (Math.min(width, x1) - Math.max(0, x0)) / width),
		height: Math.max(0, (Math.min(height, y1) - Math.max(0, y0)) / height)
	});
	if (!data.blocks) throw new Error('The OCR engine returned no layout data.');
	return {
		width, height, createdAt: Date.now(), lastUsedAt: Date.now(),
		lines: data.blocks.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines
			.filter((line) => line.text.trim())
			.map((line) => ({
				text: line.text.trim(), box: box(line.bbox),
				words: line.words.map((word) => ({ text: word.text, box: box(word.bbox), conf: word.confidence }))
			}))))
	};
}

export class OcrWorkers {
	private slots = new Set<Slot>();
	private disposed = false;
	private lifetime = new AbortController();

	async recognize(
		image: Blob, width: number, height: number, languages: readonly OcrLanguage[],
		page: number, signal: AbortSignal, onStatus: (status: OcrStatus) => void
	): Promise<OcrPage> {
		signal = AbortSignal.any([signal, this.lifetime.signal]);
		signal.throwIfAborted();
		if (this.disposed) throw new Error('The OCR workers have been disposed.');
		const key = languageKey(languages);
		const progress: Slot['progress'] = (message) => {
			if (signal.aborted || this.disposed) return;
			onStatus(message.status === 'recognizing text'
				? { state: 'recognizing', page, progress: Math.max(0, Math.min(1, message.progress)) }
				: { state: 'loading', page });
		};
		let slot = [...this.slots].find((entry) => entry.key === key && !entry.busy);
		if (!slot) {
			onStatus({ state: 'loading', page });
			const { createWorker, OEM } = await import('tesseract.js');
			signal.throwIfAborted();
			// Fetch first so missing/offline models reject before tesseract starts initialization.
			await Promise.all(key.split('+').map(async (code) => {
				const response = await fetch(new URL(`${base}${code}.traineddata.gz`, location.origin), { signal });
				if (!response.ok) throw new Error(`Could not load the ${code} OCR model (${response.status}).`);
				await response.arrayBuffer();
			}));
			signal.throwIfAborted();
			let failed!: (error: unknown) => void;
			const failure = new Promise<never>((_, reject) => { failed = reject; });
			const creating = createWorker(key, OEM.LSTM_ONLY, {
				workerPath: new URL(`${base}worker.min.js`, location.origin).href,
				corePath: new URL(base, location.origin).href,
				langPath: new URL(base, location.origin).href,
				workerBlobURL: false, cacheMethod: 'none', gzip: true,
				logger: (message) => (slot?.progress ?? progress)(message),
				errorHandler: (error: unknown) => failed(new Error(`OCR worker initialization failed: ${String(error)}`))
			});
			const cancelStartup = () => failed(new DOMException('OCR cancelled.', 'AbortError'));
			signal.addEventListener('abort', cancelStartup, { once: true });
			let worker: Worker;
			try {
				worker = await Promise.race([failure, creating]);
			} catch (error) {
				void creating.then((created) => created.terminate(), () => undefined)
					.catch((terminationError) => console.error('Could not terminate the OCR worker', terminationError));
				throw error;
			} finally {
				signal.removeEventListener('abort', cancelStartup);
			}
			if (signal.aborted || this.disposed) {
				await worker.terminate();
				throw new DOMException('OCR cancelled.', 'AbortError');
			}
			slot = { key, worker, busy: true, progress };
			this.slots.add(slot);
		}
		const current = slot;
		current.busy = true;
		current.progress = progress;
		clearTimeout(current.timer);
		let cancel: (() => void) | undefined;
		try {
			const cancelled = new Promise<never>((_, reject) => {
				cancel = () => {
					this.slots.delete(current);
					void current.worker.terminate().catch((error) => console.error('Could not terminate the OCR worker', error));
					reject(new DOMException('OCR cancelled.', 'AbortError'));
				};
				signal.addEventListener('abort', cancel, { once: true });
			});
			const work = async () => {
				await current.worker.setParameters({ user_defined_dpi: '300' });
				signal.throwIfAborted();
				return current.worker.recognize(image, {}, { blocks: true, text: true });
			};
			const result = await Promise.race([work(), cancelled]);
			signal.throwIfAborted();
			return ocrResult(result.data, width, height);
		} catch (error) {
			if (this.slots.delete(current)) await current.worker.terminate();
			throw error;
		} finally {
			if (cancel) signal.removeEventListener('abort', cancel);
			current.busy = false;
			if (this.slots.has(current)) {
				current.timer = setTimeout(() => {
					this.slots.delete(current);
					void current.worker.terminate().catch((error) => console.error('Could not terminate the idle OCR worker', error));
				}, 60_000);
			}
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.lifetime.abort();
		const slots = [...this.slots];
		this.slots.clear();
		for (const slot of slots) clearTimeout(slot.timer);
		await Promise.all(slots.map((slot) => slot.worker.terminate()));
	}
}
