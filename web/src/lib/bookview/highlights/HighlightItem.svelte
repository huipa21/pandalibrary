<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { BookFile } from '#lib/catalog/types.js';
	import { renderMarkdown } from '#lib/reader/markdown.js';
	import { readerFormat } from '#lib/reader/types.js';
	import { colorTone, matchSegments, type Mark } from './highlights-model.js';
	import { colorName } from './labels.js';

	let {
		mark,
		bookId,
		file,
		query,
		compact,
		locale
	}: {
		mark: Mark;
		bookId: number;
		file: BookFile | undefined;
		query: string;
		compact: boolean;
		locale: string;
	} = $props();

	let expanded = $state(false);
	let textElement = $state<HTMLElement | null>(null);
	let overflowing = $state(false);

	const tone = $derived(colorTone(mark.color));
	const segments = $derived(matchSegments(mark.text, query));
	const created = $derived(new Date(mark.created_at));
	const validDate = $derived(Number.isFinite(created.getTime()));
	const dayLabel = $derived(validDate ? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(created) : '');
	const yearLabel = $derived(validDate ? new Intl.DateTimeFormat(locale, { year: 'numeric' }).format(created) : '');
	const readable = $derived(file !== undefined && readerFormat(file.format) !== null);
	const clamped = $derived(compact && !expanded);

	$effect(() => {
		void clamped;
		void mark.text;
		const element = textElement;
		if (!element) return;
		const measure = () => { overflowing = element.scrollHeight > element.clientHeight + 1; };
		measure();
		const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
		observer?.observe(element);
		return () => observer?.disconnect();
	});

	$effect(() => {
		if (!compact) expanded = false;
	});
</script>

<li class="flex gap-3 py-4 sm:gap-4" data-highlight-id={mark.id}>
	<div class="w-12 shrink-0 pt-1 text-right text-xs leading-tight text-slate-500">
		{#if validDate}
			<time datetime={mark.created_at}><span class="block">{dayLabel}</span><span class="block">{yearLabel}</span></time>
		{/if}
	</div>
	<div class="w-[3px] shrink-0 self-stretch rounded-full {tone.bar}" style:background-color={tone.hex} aria-hidden="true"></div>
	<div class="min-w-0 flex-1 space-y-3">
		<span class="sr-only">{m['bv9.highlight_color']({ color: colorName(mark.color) })}</span>
		{#if mark.style === 'underline' || mark.style === 'strikeout'}
			<span class="rounded border border-slate-300 px-2 py-0.5 text-xs">{mark.style === 'underline' ? m['pv10.underline']() : m['pv10.strikeout']()}</span>
		{/if}
		<p
			bind:this={textElement}
			class="font-serif text-[1.05rem] leading-7 break-words whitespace-pre-line text-slate-900 {clamped ? 'line-clamp-2' : ''}"
			data-testid="highlight-text"
		>
			{#each segments as segment, index (index)}{#if segment.match}<mark class="rounded-sm bg-amber-200 px-0.5 text-inherit">{segment.text}</mark>{:else}{segment.text}{/if}{/each}
		</p>
		{#if compact && (overflowing || expanded)}
			<button
				type="button"
				class="text-sm font-medium text-slate-600 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
				aria-expanded={expanded}
				onclick={() => (expanded = !expanded)}
			>
				{expanded ? m['bv9.collapse']() : m['bv9.expand']()}
			</button>
		{/if}
		{#each mark.notes as note (note.id)}
			<div class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
				<p class="text-[0.7rem] font-semibold tracking-wider text-slate-500 uppercase">{m['bv9.note_label']()}</p>
				<!-- Note bodies only ever go through the shared sanitizer. -->
				<div class="reader-markdown mt-1 text-sm break-words text-slate-800 {clamped ? 'line-clamp-2' : ''}">{@html renderMarkdown(note.body_md)}</div>
			</div>
		{/each}
	</div>
	<div class="flex shrink-0 flex-col items-end gap-2">
		{#if file}
			<span class="rounded border border-slate-300 px-1.5 py-0.5 text-[0.7rem] font-semibold tracking-wide text-slate-600 uppercase">{file.format}</span>
		{/if}
		{#if readable && file}
			<a
				class="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm font-medium text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
				href={`/read/${bookId}/${file.id}?highlight=${encodeURIComponent(mark.id)}`}
				title={m['bv9.open_label']()}
			>
				{m['bv9.open']()}
			</a>
		{/if}
	</div>
</li>
