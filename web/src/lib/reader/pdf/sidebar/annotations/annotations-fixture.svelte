<script lang="ts">
	import { onMount } from 'svelte';
	import { createReaderController } from '../../../session/reader-controller.svelte.js';
	import { setPdfReaderContext } from '../../context.js';
	import { PdfViewerEngine } from '../../engine.js';
	import { createPanelAdapter, createSidebarState } from '../sidebar-state.svelte.js';
	import AnnotationsTab from './AnnotationsTab.svelte';

	const controller = createReaderController(() => ({ bookId: '21', fileId: '31', bookmarkId: null, highlightId: null }));
	const sidebar = createSidebarState({ storage: null });
	const engine = new PdfViewerEngine(document.createElement('div'), {
		relocate() {}, selection() {}, activity() {}, keyboard() {},
		error(error) { console.error('Reveal fixture engine failed', error); }
	});
	sidebar.show('annotations');
	setPdfReaderContext({
		controller, engine, sidebar, panel: createPanelAdapter(sidebar),
		view: { page: 1, pageCount: 2, fraction: 0, offset: 0, zoom: 'auto', scale: 1, layout: 'single', coverAlone: false, rotation: 0 },
		tool: { current: 'select', previous: 'select', set() {} },
		markColor: { current: 'yellow', set() {} },
		offline: false, bookLanguage: 'en', announce() {},
		ocr: { enabled: false, set() {} }, setToolbarStatus() {}
	});
	onMount(() => {
		const reveal = (event: Event) => {
			if (!(event instanceof CustomEvent)) return;
			const detail: unknown = event.detail;
			if (!detail || typeof detail !== 'object' || !('kind' in detail) || !('id' in detail) ||
				typeof detail.id !== 'string') return;
			if (detail.kind === 'mark' || detail.kind === 'note' || detail.kind === 'insert') {
				sidebar.reveal(detail.kind, detail.id);
			}
		};
		window.addEventListener('rp7-reveal', reveal);
		return () => {
			window.removeEventListener('rp7-reveal', reveal);
			controller.dispose();
			sidebar.dispose();
			void engine.destroy().catch((error: unknown) => console.error('Could not close reveal fixture engine', error));
		};
	});
</script>

<main>
	<h1>Annotations reveal fixture</h1>
	{#if controller.loadError}<p role="alert">{controller.loadError}</p>{/if}
	<div
		role="tabpanel"
		aria-label="Annotations"
		style="display: flex; height: 180px; width: 300px; --shell-text: #1f2937; --shell-surface: white; --shell-border: #cbd5e1;"
	>
		<AnnotationsTab />
	</div>
</main>
