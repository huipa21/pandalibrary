<script lang="ts">
	import type { Book } from '#lib/catalog/types.js';
	import * as m from '#lib/paraglide/messages.js';
	import type { Progress } from '#lib/reader/types.js';
	import FormatBadge from '../FormatBadge.svelte';
	import { formatPercent, formatSize } from '../format.js';

	let { book, progress }: { book: Book; progress: Progress | null } = $props();
</script>

<section class="min-w-0 space-y-4 rounded-2xl border border-slate-200 bg-white p-5" aria-labelledby="book-editions-heading">
	<h2 id="book-editions-heading" class="text-xs font-semibold tracking-wider text-slate-500 uppercase">{m['bv6.editions']()}</h2>
	{#if book.files.length}
		<ul class="space-y-4">
			{#each book.files as file (file.id)}
				<li class="space-y-2">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<FormatBadge files={[file]} size="xs" />
						<span class="text-xs text-slate-500">{formatSize(file.size_bytes)}</span>
					</div>
					{#if progress?.book_file_id === file.id}
						<div class="flex items-center gap-2">
							<div
								class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100"
								role="progressbar"
								aria-label={m['bv6.progress']()}
								aria-valuemin="0"
								aria-valuemax="100"
								aria-valuenow={Math.round(progress.percentage * 100)}
							>
								<div class="h-full rounded-full bg-emerald-500" style={`width: ${Math.max(0, Math.min(100, progress.percentage * 100))}%`}></div>
							</div>
							<span class="text-xs text-slate-600">{formatPercent(progress.percentage)}</span>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-sm text-slate-500">{m['catalog.book.no_files']()}</p>
	{/if}
	<a class="inline-block text-sm font-semibold text-emerald-800 underline-offset-4 hover:underline" href={`/books/${book.id}/files`}>
		{m['bv6.files_on_disk']({ count: String(book.files.length) })}
	</a>
</section>
