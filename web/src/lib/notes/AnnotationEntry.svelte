<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import BookCover from '#lib/bookview/BookCover.svelte';
	import { renderMarkdown } from '#lib/reader/markdown.js';
	import { strokePath } from '#lib/reader/pdf/insert/ink.js';
	import type { AnnotationEntry } from './types.js';
	import { annotationHref, annotationKind, annotationTagClass } from './entry.js';

	let { item }: { item: AnnotationEntry } = $props();
	const href = $derived(annotationHref(item));
	const kind = $derived(annotationKind(item));
	const formatter = $derived(new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }));
	const date = $derived(new Date(item.created_at));
	const label = $derived(kind === 'review' ? m['notes.activity.review']()
		: kind === 'comment' ? m['notes.activity.comment']()
		: kind === 'highlight' ? m['notes.kind.highlight']()
		: kind === 'underline' ? m['pv10.underline']()
		: kind === 'strikeout' ? m['pv10.strikeout']()
		: kind === 'text' ? m['pv10.text']()
		: kind === 'ink' ? m['pv10.drawing']()
		: kind === 'image' ? m['pv10.image']()
		: m['notes.activity.private_note']());
</script>

<a {href} class="flex min-w-0 items-start gap-3 rounded-md py-4 text-inherit no-underline hover:bg-white/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700">
	<div class="w-12 shrink-0">
		<BookCover id={item.book_id} title={item.book_title} coverUrl={item.cover_url} size="xs" class="w-12" />
	</div>
	<div class="min-w-0 flex-1 space-y-1">
		<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
			<span class="rounded-full px-2 py-0.5 text-xs font-semibold {annotationTagClass(kind)}">{label}</span>
			<time class="text-xs text-slate-500" datetime={item.created_at}>{Number.isNaN(date.getTime()) ? item.created_at : formatter.format(date)}</time>
			{#if item.locator}<span class="text-xs text-slate-500">{m['notes.page']({ page: item.locator.page })}</span>{/if}
		</div>
		<p class="break-words font-medium text-slate-900">{item.book_title}</p>
		{#if kind === 'comment' && item.anchor}
			<blockquote class="border-l-2 border-emerald-700 pl-3 text-sm text-slate-600">{item.anchor}</blockquote>
		{/if}
		{#if kind === 'ink' && item.locator && item.data}
			<svg class="h-32 max-w-full rounded border border-slate-200 bg-white" role="img" aria-label={m['pv10.drawing']()}
				viewBox={`${item.locator.rect.x} ${item.locator.rect.y} ${item.locator.rect.width} ${item.locator.rect.height}`}>
				{#each item.data.strokes as stroke}
					<path d={strokePath(stroke)} fill="none" stroke={item.data.color} stroke-width={item.data.width} stroke-linecap="round" stroke-linejoin="round" />
				{/each}
			</svg>
		{:else if kind === 'comment' || kind === 'book_note'}
			<div class="reader-markdown break-words text-sm leading-6 text-slate-800">{@html renderMarkdown(item.content, false)}</div>
		{:else}
			<p class="break-words whitespace-pre-wrap text-sm leading-6 text-slate-800">{item.content}</p>
		{/if}
	</div>
</a>
