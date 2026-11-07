<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { focusRing } from '#lib/admin/ui.js';
	import BookCover from '#lib/bookview/BookCover.svelte';
	import { heapThumbnailUrl } from './api.js';
	import { heapStatusClasses, heapStatusLabels } from './status.js';
	import type { HeapItem } from './types.js';

	interface Props {
		item: HeapItem;
		selected: boolean;
		ontoggle: (item: HeapItem) => void;
	}

	let { item, selected, ontoggle }: Props = $props();
</script>

<li class="min-w-0 space-y-2" data-testid="bh4-row" data-heap-tile data-id={item.id}>
	<div class={`heap-tile relative rounded-md ${selected ? 'ring-2 ring-slate-900 ring-offset-2' : ''}`}>
		<BookCover id={item.id} title={item.title} authors={item.authors} series={item.series} coverUrl={heapThumbnailUrl(item)} />
		<label class="absolute top-2 left-2 grid size-7 place-items-center rounded bg-white shadow-sm">
			<input
				type="checkbox"
				class={`size-4 ${focusRing}`}
				checked={selected}
				aria-label={m['bh4.list.select_item']({ title: item.title })}
				onchange={() => ontoggle(item)}
			/>
		</label>
		<span
			class={`absolute top-2 right-2 max-w-[calc(100%-3.5rem)] truncate rounded-full border px-2 py-0.5 text-xs font-medium shadow-sm ${heapStatusClasses[item.status]}`}
			data-testid="bh4-row-status"
			title={heapStatusLabels[item.status]()}
		>{heapStatusLabels[item.status]()}</span>
	</div>
	<div class="space-y-0.5">
		<p class="line-clamp-2 text-sm font-medium" title={item.title} data-testid="bh4-row-title">{item.title}</p>
		<p class="truncate text-xs text-slate-500" title={item.rel_path}>{item.file_name}</p>
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

<style>
	.heap-tile {
		transition: transform 150ms, box-shadow 150ms;
	}

	.heap-tile:focus-within {
		transform: translateY(-4px);
		box-shadow: 0 8px 20px rgb(0 0 0 / 18%);
	}

	@media (hover: hover) {
		.heap-tile:hover {
			transform: translateY(-4px);
			box-shadow: 0 8px 20px rgb(0 0 0 / 18%);
		}
	}

	@media (hover: none), (prefers-reduced-motion: reduce) {
		.heap-tile {
			transition: none;
		}

		.heap-tile:hover,
		.heap-tile:focus-within {
			transform: none;
		}
	}
</style>
