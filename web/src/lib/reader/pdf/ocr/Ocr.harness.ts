import { getDocument, GlobalWorkerOptions, OPS, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PdfBinaryDataFactory } from '../binary-data.js';
import { PdfViewerEngine } from '../engine.js';
import { DEFAULT_SETTINGS } from '../../settings.js';
import type { ReaderSelection } from '../../types.js';
import { ocrLanguagesFor } from './languages.js';
import { setActiveViewer } from '#lib/sync/db.js';
import { createOcrEnhancer } from './enhancer.js';
import type { OcrPageContext } from './types.js';
import type { OcrStatus } from './status.js';
import { buildOcrTextLayer } from './text-layer.js';

GlobalWorkerOptions.workerSrc = workerUrl;
const root = document.querySelector<HTMLElement>('#pages')!;
let pdf: PDFDocumentProxy | undefined;
let loadingTask: PDFDocumentLoadingTask | undefined;
let enabled = true;
let active = true;
let contexts: OcrPageContext[] = [];
let lifetime = new AbortController();
let enhance: ReturnType<typeof createOcrEnhancer> | undefined;

async function open(base64: string, options: { enabled?: boolean; active?: boolean } = {}) {
	lifetime.abort();
	await enhance?.dispose();
	await loadingTask?.destroy();
	lifetime = new AbortController();
	root.replaceChildren();
	enabled = options.enabled ?? true;
	active = options.active ?? true;
	await setActiveViewer({ id: 1, username: 'ocr', display_name: 'OCR', role: 'user', locale: 'en' });
	loadingTask = getDocument({
		data: Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
		BinaryDataFactory: PdfBinaryDataFactory, useWorkerFetch: false
	});
	pdf = await loadingTask.promise;
	const fingerprint = pdf.fingerprints[0];
	if (!fingerprint) throw new Error('The PDF fixture has no fingerprint.');
	enhance = createOcrEnhancer({
		enabled: () => enabled, active: () => active, languages: () => ['chi_sim', 'eng'],
		fingerprint: () => fingerprint, visiblePage: () => 1,
		onStatus: (status: OcrStatus) => {
			document.querySelector('#status')!.textContent = JSON.stringify(status);
			harness.status = status;
		}
	});
	contexts = [];
	for (let number = 1; number <= pdf.numPages; number++) {
		const page = await pdf.getPage(number);
		const viewport = page.getViewport({ scale: 1, rotation: 0 });
		const pageDiv = document.createElement('div');
		pageDiv.dataset.page = String(number);
		Object.assign(pageDiv.style, { position: 'relative', width: `${viewport.width}px`, height: `${viewport.height}px`, marginBottom: '20px' });
		const canvas = document.createElement('canvas');
		canvas.width = viewport.width;
		canvas.height = viewport.height;
		pageDiv.append(canvas);
		root.append(pageDiv);
		await page.render({ canvas, viewport }).promise;
		const overlay = document.createElement('div');
		Object.assign(overlay.style, { position: 'absolute', top: '0', left: '0', width: `${viewport.width}px`, height: `${viewport.height}px`, transformOrigin: '0 0' });
		pageDiv.append(overlay);
		const [text, operators] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
		const images = new Set<number>([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat]);
		contexts.push({
			page: number, pdfPage: page, pageDiv, overlay, rotation: 0, textLayer: null,
			textChars: text.items.reduce((sum, item) => sum + ('str' in item ? item.str.replace(/\s/g, '').length : 0), 0),
			hasImages: operators.fnArray.some((op) => images.has(op)), signal: lifetime.signal
		});
	}
	await Promise.all(contexts.map((context) => enhance!(context)));
}

/** Opens the fixture in the real reader engine with the enhancer registered as the live reader does. */
async function openLive(base64: string, options: { rotation?: 0 | 90 | 180 | 270 } = {}) {
	await harness.dispose();
	lifetime = new AbortController();
	root.replaceChildren();
	await setActiveViewer({ id: 1, username: 'ocr', display_name: 'OCR', role: 'user', locale: 'en' });
	const surface = document.createElement('div');
	Object.assign(surface.style, { position: 'relative', width: '900px', height: '700px', overflow: 'hidden' });
	root.append(surface);
	const reader = new PdfViewerEngine(surface, {
		relocate: () => {}, activity: () => {}, keyboard: () => {},
		selection: (selection) => { harness.selection = selection; },
		error: (error) => console.error(error)
	});
	harness.live = reader;
	await reader.open(new Blob([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))]));
	enhance = createOcrEnhancer({
		enabled: () => true, active: () => true, languages: () => ocrLanguagesFor(null),
		fingerprint: () => reader.fingerprint(), visiblePage: () => reader.state.page,
		onStatus: (status: OcrStatus) => { harness.status = status; }
	});
	harness.removeEnhancer = reader.addPageEnhancer(enhance);
	await reader.applySettings({ ...DEFAULT_SETTINGS, pdfLayout: 'single-continuous', pdfRotation: options.rotation ?? 0 });
	await reader.goTo({ type: 'pdf', page: 1 });
}

function rotate() {
	for (const context of contexts) {
		const width = context.overlay.clientWidth;
		const height = context.overlay.clientHeight;
		context.overlay.style.transform = `translateX(${height}px) rotate(90deg)`;
		Object.assign(context.pageDiv.style, { width: `${height}px`, height: `${width}px` });
		const canvas = context.pageDiv.querySelector('canvas')!;
		Object.assign(canvas.style, { position: 'absolute', transformOrigin: '0 0', transform: `translateX(${height}px) rotate(90deg)` });
	}
}

const harness = {
	open, rotate, openLive,
	status: { state: 'idle' } as OcrStatus,
	selection: null as ReaderSelection | null,
	live: null as PdfViewerEngine | null,
	removeEnhancer: null as (() => void) | null,
	cancel: () => lifetime.abort(),
	dispose: async () => {
		lifetime.abort();
		await enhance?.dispose();
		await loadingTask?.destroy();
		harness.removeEnhancer = null;
		await harness.live?.destroy();
		harness.live = null;
	},
	textFixture() {
		root.replaceChildren();
		const overlay = document.createElement('div');
		Object.assign(overlay.style, { position: 'relative', width: '600px', height: '300px' });
		root.append(overlay);
		const cleanup = buildOcrTextLayer(overlay, {
			width: 600, height: 300, createdAt: 1, lastUsedAt: 1,
			lines: [{ text: '', box: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 }, words: ['扫', '描', 'sample'].map((text) => ({
				text, box: { x: 0, y: 0, width: 0, height: 0 }, conf: 99
			})) }]
		}, lifetime.signal);
		return { cleanup };
	}
};

declare global {
	interface Window { ocrHarness: typeof harness }
}
window.ocrHarness = harness;
