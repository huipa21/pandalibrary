<script lang="ts">
	import { onMount } from 'svelte';
	import { getPdfReaderContext } from '../context.js';
	import { ocrLanguagesFor } from './languages.js';
	import OcrStatusChip from './OcrStatusChip.svelte';
	import type { OcrStatus } from './status.js';
	import type { createOcrEnhancer } from './enhancer.js';

	const reader = getPdfReaderContext();
	let status = $state<OcrStatus>({ state: 'idle' });
	let enhancer = $state<ReturnType<typeof createOcrEnhancer> | null>(null);

	onMount(() => {
		const engine = reader.engine;
		let disposed = false;
		reader.setToolbarStatus('ocr', chip);
		// Loaded lazily so non-scanned reading never pulls in the OCR runtime.
		void import('./enhancer.js').then(({ createOcrEnhancer }) => {
			if (disposed) return;
			enhancer = createOcrEnhancer({
				enabled: () => reader.ocr.enabled,
				active: () => !disposed,
				languages: () => ocrLanguagesFor(reader.bookLanguage),
				fingerprint: () => engine.fingerprint() || `book-file:${reader.controller.file?.id ?? 'unknown'}`,
				visiblePage: () => engine.state.page,
				onStatus: (next) => { status = next; }
			});
		}).catch((error) => console.error('Could not load scanned-page recognition', error));
		return () => {
			disposed = true;
			void enhancer?.dispose();
			reader.setToolbarStatus('ocr', null);
		};
	});

	$effect(() => {
		const enabled = reader.ocr.enabled;
		if (enhancer && enabled) return reader.engine.addPageEnhancer(enhancer);
	});
</script>

{#snippet chip()}<OcrStatusChip {status} />{/snippet}
