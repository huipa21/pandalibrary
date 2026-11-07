<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { BookFile } from '#lib/catalog/types.js';
	import HighlightItem from './HighlightItem.svelte';
	import { chapterKey, type ChapterGroup } from './highlights-model.js';

	let {
		groups,
		chapterIds,
		bookId,
		files,
		query,
		compact,
		locale
	}: {
		groups: ChapterGroup[];
		chapterIds: ReadonlyMap<string, string>;
		bookId: number;
		files: readonly BookFile[];
		query: string;
		compact: boolean;
		locale: string;
	} = $props();

	const filesById = $derived(new Map(files.map((file) => [file.id, file])));
</script>

<div class="space-y-8" role="region" aria-label={m['bv9.list_label']()}>
	{#each groups as group (chapterKey(group))}
		{@const id = chapterIds.get(chapterKey(group))}
		<section aria-labelledby={id} class="scroll-mt-28">
			<h2 {id} tabindex="-1" class="flex items-center gap-3 text-sm font-semibold tracking-wide text-slate-600 [font-variant-caps:all-small-caps] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900">
				<span class="min-w-0 truncate" title={group.chapter}>{group.chapter}</span>
				<span class="h-px flex-1 bg-slate-200" aria-hidden="true"></span>
				<span class="text-xs font-medium text-slate-500 tabular-nums [font-variant-caps:normal]" aria-hidden="true">{group.marks.length}</span>
				<span class="sr-only">({m['bv9.chapter_count_label']({ count: group.marks.length })})</span>
			</h2>
			<ul class="divide-y divide-slate-100">
				{#each group.marks as mark (mark.id)}
					<HighlightItem
						{mark}
						{bookId}
						file={mark.book_file_id === null ? undefined : filesById.get(mark.book_file_id)}
						{query}
						{compact}
						{locale}
					/>
				{/each}
			</ul>
		</section>
	{/each}
</div>
