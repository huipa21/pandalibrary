<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { focusRing } from '#lib/admin/ui.js';
	import { heapThumbnailUrl } from './api.js';
	import { formatBytes } from './upload-queue.svelte.js';
	import type { HeapItem, HeapItemStatus } from './types.js';

	interface Props {
		item: HeapItem;
		selected: boolean;
		ontoggle: (item: HeapItem) => void;
	}

	let { item, selected, ontoggle }: Props = $props();
	let coverFailed = $state(false);

	const cover = $derived(coverFailed ? null : heapThumbnailUrl(item));
	const added = $derived.by(() => {
		const date = new Date(item.created_at);
		return Number.isNaN(date.getTime()) ? item.created_at : new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(date);
	});
	const showPath = $derived(item.rel_path !== item.file_name);

	const statusLabels: Record<HeapItemStatus, () => string> = {
		ready: m['bh4.status.ready'],
		duplicate: m['bh4.status.duplicate'],
		invalid: m['bh4.status.invalid'],
		queued: m['bh4.status.queued'],
		importing: m['bh4.status.importing'],
		failed: m['bh4.status.failed']
	};
	const statusClasses: Record<HeapItemStatus, string> = {
		ready: 'border-emerald-200 bg-emerald-50 text-emerald-900',
		duplicate: 'border-amber-300 bg-amber-50 text-amber-950',
		invalid: 'border-red-200 bg-red-50 text-red-900',
		queued: 'border-sky-200 bg-sky-50 text-sky-900',
		importing: 'border-sky-200 bg-sky-50 text-sky-900',
		failed: 'border-red-200 bg-red-50 text-red-900'
	};

	$effect(() => {
		void item.cover_url;
		coverFailed = false;
	});
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
	<div class="row-span-2 h-16 w-12 shrink-0 overflow-hidden rounded border border-slate-200 bg-slate-100 md:row-span-1">
		{#if cover}
			<img src={cover} alt="" class="h-full w-full object-cover" loading="lazy" onerror={() => (coverFailed = true)} />
		{:else}
			<div class="grid h-full w-full place-items-center text-slate-400" data-testid="bh4-cover-placeholder">
				<svg aria-hidden="true" viewBox="0 0 20 20" class="size-5" fill="none" stroke="currentColor" stroke-width="1.5">
					<path d="M5 3h8l3 3v11H5z M13 3v3h3" stroke-linejoin="round" />
				</svg>
			</div>
		{/if}
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
		<span class={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${statusClasses[item.status]}`} data-testid="bh4-row-status">
			{statusLabels[item.status]()}
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
