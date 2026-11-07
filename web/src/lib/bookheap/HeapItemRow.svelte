<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { focusRing } from '#lib/admin/ui.js';
	import BookCover from '#lib/bookview/BookCover.svelte';
	import { heapThumbnailUrl } from './api.js';
	import { heapStatusClasses, heapStatusLabels } from './status.js';
	import { formatBytes } from './upload-queue.svelte.js';
	import type { HeapItem } from './types.js';

	interface Props {
		item: HeapItem;
		selected: boolean;
		ontoggle: (item: HeapItem) => void;
	}

	let { item, selected, ontoggle }: Props = $props();
	const added = $derived.by(() => {
		const date = new Date(item.created_at);
		return Number.isNaN(date.getTime()) ? item.created_at : new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(date);
	});
	const showPath = $derived(item.rel_path !== item.file_name);
</script>

<li
	class={`grid grid-cols-[auto_auto_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lg border bg-white p-3 md:grid-cols-[auto_auto_minmax(0,1fr)_9rem_10rem] md:items-center ${selected ? 'border-slate-900 ring-1 ring-slate-900' : 'border-slate-200'}`}
	data-testid="bh4-row"
	data-id={item.id}
>
	<input
		type="checkbox"
		class={`mt-1 size-4 md:mt-0 ${focusRing}`}
		checked={selected}
		aria-label={m['bh4.list.select_item']({ title: item.title })}
		onchange={() => ontoggle(item)}
	/>
	<div class="row-span-2 w-12 shrink-0 md:row-span-1">
		<BookCover size="xs" id={item.id} title={item.title} authors={item.authors} coverUrl={heapThumbnailUrl(item)} class="w-12" />
	</div>
	<div class="min-w-0 space-y-0.5">
		<p class="font-medium break-words" data-testid="bh4-row-title">{item.title}</p>
		{#if item.authors.length > 0}
			<p class="text-sm text-slate-700">{item.authors.join(', ')}</p>
		{/if}
		<p class="text-xs break-all text-slate-500" title={item.rel_path}>
			{item.file_name}{#if showPath}<span class="sr-only">, </span><span class="block">{item.rel_path}</span>{/if}
		</p>
	</div>
	<div class="col-start-3 flex flex-wrap items-center gap-2 text-xs text-slate-600 md:col-start-auto md:flex-col md:items-start md:gap-1">
		<span class="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 font-mono text-[0.7rem] text-slate-800 uppercase">
			{item.format ?? m['bh4.list.unknown_format']()}
		</span>
		<span>{formatBytes(item.size_bytes, getLocale())}</span>
		<span>{item.source === 'scan' ? m['bh4.source.scan']() : m['bh4.source.upload']()} · <time datetime={item.created_at}>{added}</time></span>
	</div>
	<div class="col-start-3 space-y-1 text-sm md:col-start-auto">
		<span class={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${heapStatusClasses[item.status]}`} data-testid="bh4-row-status">
			{heapStatusLabels[item.status]()}
		</span>
		{#if item.error}
			<p class="text-xs break-words text-slate-700" data-testid="bh4-row-error">{item.error}</p>
		{/if}
		{#if item.status === 'duplicate' && item.duplicate_of_book_id !== null}
			<a class={`block text-xs underline underline-offset-4 ${focusRing}`} href={`/books/${item.duplicate_of_book_id}`}>
				{m['bh4.list.duplicate_book']()}
			</a>
		{:else if item.status === 'duplicate' && item.duplicate_of_item_id !== null}
			<p class="text-xs text-slate-600">{m['bh4.list.duplicate_item']({ id: item.duplicate_of_item_id })}</p>
		{/if}
	</div>
</li>
