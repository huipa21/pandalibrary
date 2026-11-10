<script lang="ts">
	import { onMount } from 'svelte';
	import { createReaderController } from '../../../session/reader-controller.svelte.js';
	import { setPdfReaderContext } from '../../context.js';
	import { createSidebarState } from '../sidebar-state.svelte.js';
	import BookmarksTab from './BookmarksTab.svelte';

	const controller = createReaderController(() => ({ bookId: '21', fileId: '31', bookmarkId: null, highlightId: null }));
	const sidebar = createSidebarState({ storage: null });
	sidebar.show('bookmarks');
	setPdfReaderContext({
		controller, sidebar,
		get engine(): never { throw new Error('The bookmarks reveal fixture does not mount a PDF engine.'); },
		view: { page: 1, pageCount: 2, fraction: 0, offset: 0, zoom: 'auto', scale: 1, layout: 'single', rotation: 0 },
		tool: { current: 'select', previous: 'select', set() {} },
		offline: false, bookLanguage: 'en', announce() {},
		ocr: { enabled: false, set() {} }, setToolbarStatus() {}
	});
	onMount(() => {
		const reveal = (event: Event) => {
			if (event instanceof CustomEvent && typeof event.detail === 'string') sidebar.reveal('bookmark', event.detail);
		};
		window.addEventListener('rp8-reveal', reveal);
		return () => {
			window.removeEventListener('rp8-reveal', reveal);
			controller.dispose();
			sidebar.dispose();
		};
	});
</script>

<main>
	<h1>Bookmarks reveal fixture</h1>
	{#if controller.loadError}<p role="alert">{controller.loadError}</p>{/if}
	<div style="height: 160px; overflow-y: auto; width: 300px; --shell-text: #1f2937; --shell-surface: white; --shell-border: #cbd5e1;">
		<BookmarksTab />
	</div>
</main>
