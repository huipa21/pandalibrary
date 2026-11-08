<script lang="ts">
	import { onDestroy } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getBook, listBooks, listLibraries, MAX_PAGE_SIZE } from '#lib/catalog/api.js';
	import { downloadBookFile } from '#lib/reader/api.js';
	import { uploadPdfCover } from './api.js';
	import {
		runPdfCoverBatch,
		type PdfCoverProgress,
		type PdfCoverReason,
		type PdfCoverResult
	} from './pdf-covers.js';

	let running = $state(false);
	let cancelling = $state(false);
	let progress = $state<PdfCoverProgress | null>(null);
	let results = $state<PdfCoverResult[]>([]);
	let finished = $state<'done' | 'cancelled' | 'error' | null>(null);
	let controller: AbortController | null = null;

	onDestroy(() => controller?.abort());

	const reasons: Record<PdfCoverReason, () => string> = {
		has_cover: m['metadata.pdf.reason.has_cover'],
		no_pdf: m['metadata.pdf.reason.no_pdf'],
		not_found: m['metadata.pdf.reason.not_found'],
		check: m['metadata.pdf.reason.check'],
		too_large: m['metadata.pdf.reason.too_large'],
		download: m['metadata.pdf.reason.download'],
		render: m['metadata.pdf.reason.render'],
		upload: m['metadata.pdf.reason.upload']
	};

	function outcomeLabel(result: PdfCoverResult): string {
		const label = result.outcome === 'generated'
			? m['metadata.pdf.outcome.generated']()
			: result.outcome === 'skipped'
				? m['metadata.pdf.outcome.skipped']()
				: m['metadata.pdf.outcome.failed']();
		return result.reason ? `${label}: ${reasons[result.reason]()}` : label;
	}

	async function start() {
		if (running) return;
		const abort = new AbortController();
		controller = abort;
		running = true;
		cancelling = false;
		finished = null;
		results = [];
		progress = null;
		try {
			const { renderPdfFirstPage } = await import('./pdf-render.js');
			const summary = await runPdfCoverBatch(
				{
					listLibraries: (cursor) => listLibraries({ cursor, limit: MAX_PAGE_SIZE }),
					listBooks: (libraryId, cursor) => listBooks({ library_id: libraryId }, 'title', { cursor, limit: MAX_PAGE_SIZE }),
					getBook,
					download: (book, file) => downloadBookFile(book.id, file),
					render: (pdf) => renderPdfFirstPage(pdf),
					upload: (bookId, image) => uploadPdfCover(bookId, image)
				},
				{
					signal: abort.signal,
					onProgress: (next) => {
						if (controller === abort) progress = next;
					},
					onResult: (result) => {
						if (controller === abort) results = [...results, result];
					}
				}
			);
			if (controller === abort) finished = summary.cancelled ? 'cancelled' : 'done';
		} catch (error) {
			console.error('PDF cover generation stopped', error);
			if (controller === abort) finished = 'error';
		} finally {
			if (controller === abort) {
				running = false;
				cancelling = false;
				controller = null;
			}
		}
	}

	function cancel() {
		if (!controller) return;
		cancelling = true;
		controller.abort();
	}
</script>

<section aria-labelledby="pdf-cover-heading" class="space-y-4 card p-4">
	<div class="space-y-1">
		<h2 id="pdf-cover-heading" class="text-xl font-semibold">{m['metadata.pdf.title']()}</h2>
		<p class="text-sm text-slate-600">{m['metadata.pdf.description']()}</p>
	</div>
	<div class="flex flex-wrap gap-3">
		<button
			class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-60"
			disabled={running}
			onclick={start}
		>
			{m['metadata.pdf.start']()}
		</button>
		{#if running}
			<button
				class="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium focus-visible:outline-2 disabled:opacity-60"
				disabled={cancelling}
				onclick={cancel}
			>
				{cancelling ? m['metadata.pdf.cancelling']() : m['metadata.pdf.cancel']()}
			</button>
		{/if}
	</div>

	<div aria-live="polite" class="space-y-1 text-sm" role="status">
		{#if progress}
			<p>{m['metadata.pdf.progress']({ scanned: progress.scanned, generated: progress.generated, skipped: progress.skipped, failed: progress.failed })}</p>
			{#if progress.current}<p class="text-slate-600">{m['metadata.pdf.current']({ title: progress.current.title })}</p>{/if}
		{/if}
		{#if finished === 'done'}
			<p class="text-green-800">{progress && progress.eligible === 0 ? m['metadata.pdf.none']() : m['metadata.pdf.done']()}</p>
		{:else if finished === 'cancelled'}
			<p class="text-amber-800">{m['metadata.pdf.cancelled']()}</p>
		{/if}
	</div>
	{#if finished === 'error'}
		<p class="rounded-md bg-red-50 p-3 text-sm text-red-800" role="alert">{m['metadata.pdf.error']()}</p>
	{/if}

	{#if results.length}
		<div class="space-y-2">
			<h3 class="font-medium">{m['metadata.pdf.results']()}</h3>
			<ul class="max-h-80 divide-y divide-slate-200 overflow-y-auto rounded-md border border-slate-200 text-sm">
				{#each results as result (result.bookId)}
					<li class="flex flex-wrap justify-between gap-2 p-2" data-outcome={result.outcome}>
						<a class="font-medium underline-offset-4 hover:underline focus-visible:outline-2" href={`/books/${result.bookId}`}>{result.title}</a>
						<span class={result.outcome === 'failed' ? 'text-red-700' : result.outcome === 'skipped' ? 'text-amber-800' : 'text-green-700'}>
							{outcomeLabel(result)}
						</span>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</section>
