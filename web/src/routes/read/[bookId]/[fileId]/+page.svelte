<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { createReaderController } from '#lib/reader/session/reader-controller.svelte.js';
	import LegacyReaderView from '#lib/reader/views/LegacyReaderView.svelte';
	import PdfReaderView from '#lib/reader/views/PdfReaderView.svelte';
	const controller = createReaderController(() => ({
		bookId: page.params.bookId ?? '', fileId: page.params.fileId ?? '',
		bookmarkId: page.url.searchParams.get('bookmark'), highlightId: page.url.searchParams.get('highlight'),
		annotationId: page.url.searchParams.get('annotation')
	}));
	onMount(() => controller.mount());
	beforeNavigate((navigation) => controller.beforeNavigate(navigation));
	onDestroy(() => controller.dispose());
</script>

{#if controller.loadError}
	<div class="space-y-4" role="alert">
		<p class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">{controller.loadError}</p>
		<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => controller.retry()}>{m['reader.retry']()}</button>
		<a class="ml-4 underline underline-offset-4 focus-visible:outline-2" href="/read">{m['reader.back_to_books']()}</a>
	</div>
{:else if !controller.book || !controller.file || !controller.format}
	<p class="text-slate-600" role="status">{m['reader.loading']()}</p>
{:else if controller.format === 'pdf'}
	<PdfReaderView {controller} />
{:else}
	<LegacyReaderView {controller} />
{/if}
