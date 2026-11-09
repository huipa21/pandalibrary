import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OcrWorkers } from './worker.js';

const engine = vi.hoisted(() => ({
	recognize: vi.fn(async () => ({ data: { blocks: [] } })),
	setParameters: vi.fn(async () => {}),
	terminate: vi.fn(async () => {}),
	createWorker: vi.fn()
}));
vi.mock('tesseract.js', () => ({
	OEM: { LSTM_ONLY: 1 },
	createWorker: engine.createWorker
}));

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('location', { origin: 'https://library.test' });
	vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([31, 139]))));
	engine.createWorker.mockImplementation(async () => engine);
});
afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

it('uses self-hosted URLs and reuses a language-set worker until 60 seconds idle', async () => {
	const workers = new OcrWorkers();
	const signal = new AbortController().signal;
	const status = vi.fn();
	await workers.recognize(new Blob(), 100, 200, ['chi_sim', 'eng'], 1, signal, status);
	await workers.recognize(new Blob(), 100, 200, ['eng', 'chi_sim'], 2, signal, status);
	expect(engine.createWorker).toHaveBeenCalledOnce();
	expect(engine.createWorker.mock.calls[0][2]).toMatchObject({
		cacheMethod: 'none', workerBlobURL: false, gzip: true,
		workerPath: expect.stringMatching(/^https:\/\/library.test\/_app\/immutable\/ocr\/.+\/worker.min.js$/),
		corePath: expect.stringMatching(/^https:\/\/library.test\/_app\/immutable\/ocr\//),
		langPath: expect.stringMatching(/^https:\/\/library.test\/_app\/immutable\/ocr\//)
	});
	expect(engine.recognize).toHaveBeenCalledWith(expect.any(Blob), {}, { blocks: true, text: true });
	await vi.advanceTimersByTimeAsync(59_999);
	expect(engine.terminate).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(engine.terminate).toHaveBeenCalledOnce();
	await workers.dispose();
});

it('terminates and rejects running recognition on abort without waiting for tesseract', async () => {
	const workers = new OcrWorkers();
	const controller = new AbortController();
	let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	engine.recognize.mockImplementationOnce(() => { started(); return new Promise(() => {}); });
	const job = workers.recognize(new Blob(), 100, 200, ['eng'], 1, controller.signal, vi.fn());
	const failed = expect(job).rejects.toMatchObject({ name: 'AbortError' });
	await ready;
	controller.abort();
	await failed;
	expect(engine.terminate).toHaveBeenCalledOnce();
	await workers.dispose();
});

it('dispose cancels in-flight work and terminates idle workers', async () => {
	const workers = new OcrWorkers();
	await workers.recognize(new Blob(), 100, 200, ['eng'], 1, new AbortController().signal, vi.fn());
	await workers.dispose();
	expect(engine.terminate).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});

it('reports missing offline models before creating a worker', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
	const workers = new OcrWorkers();
	await expect(workers.recognize(new Blob(), 100, 200, ['eng'], 1, new AbortController().signal, vi.fn()))
		.rejects.toThrow('Could not load the eng OCR model (404)');
	expect(engine.createWorker).not.toHaveBeenCalled();
	await workers.dispose();
});

it('surfaces initialization errors instead of waiting indefinitely', async () => {
	engine.createWorker.mockImplementationOnce(async (_langs, _oem, options) => {
		options.errorHandler('Bad model');
		return engine;
	});
	const workers = new OcrWorkers();
	await expect(workers.recognize(new Blob(), 100, 200, ['eng'], 1, new AbortController().signal, vi.fn()))
		.rejects.toThrow('Bad model');
	await workers.dispose();
});
