<script lang="ts">
	import type { Book } from '#lib/catalog/types.js';
	import type { Snippet } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import BookCover from '../BookCover.svelte';
	import Icon from '../Icon.svelte';
	import { formatTone } from '../cover.js';
	import { formatSize } from '../format.js';
	import type { FilesModel } from './files-model.js';

	interface Props {
		book: Book;
		coverSource: string | null;
		libraryName: string;
		model: FilesModel;
		online: boolean;
		actions: Snippet;
		collections: Snippet;
	}

	let { book, coverSource, libraryName, model, online, actions, collections }: Props = $props();
	const author = $derived(book.authors.find((item) => item.role === 'author')?.name);
	const primary = $derived(model.groups.flatMap((group) => group.files).find((file) => file.id === model.primaryFileId));
</script>

<div class="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
	<section class="card min-w-0 p-4 sm:p-6">
		<h1 class="sr-only">{m['bv7.title']()}</h1>
		<div class="flex min-w-0 items-center gap-4">
			<div class="w-20 shrink-0">
				<BookCover
					id={book.id}
					title={book.title}
					subtitle={book.subtitle}
					series={book.series?.name}
					authors={book.authors.map((item) => item.name)}
					coverUrl={coverSource}
					size="sm"
				/>
			</div>
			<div class="min-w-0">
				<h2 class="break-words text-lg font-semibold text-slate-900">{book.title}</h2>
				<nav aria-label={m['bv7.breadcrumb']()} class="mt-1 flex min-w-0 items-center gap-1.5 text-sm text-slate-500">
					{#if author}<span class="min-w-0 truncate" title={author}>{author}</span>{/if}
					{#if primary}{#if author}<span aria-hidden="true">/</span>{/if}<span class="min-w-0 truncate" title={primary.original_filename}>{primary.original_filename}</span>{/if}
				</nav>
			</div>
		</div>
		<div class="mt-4 flex flex-wrap items-center gap-2">{@render actions()}</div>
	</section>
	<section class="card min-w-0 p-4 sm:p-6">
		<div class="flex min-w-0 flex-wrap items-start gap-3">
			<section class="flex min-w-0" aria-label={m['bv6.library']()}>
				{#snippet libraryTag()}
					<Icon name="book-open" class="size-3.5 shrink-0" /><span class="truncate">{libraryName}</span>
				{/snippet}
				{#if online}
					<a href={`/library/${book.library_id}`} title={`${m['bv6.library']()}: ${libraryName}`} class="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 focus-visible:outline-2 focus-visible:outline-emerald-700">{@render libraryTag()}</a>
				{:else}
					<span title={m['bv6.library']()} class="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">{@render libraryTag()}</span>
				{/if}
			</section>
			{@render collections()}
		</div>
		<dl class="mt-5 grid grid-cols-3 gap-3 border-t border-slate-100 pt-4 sm:gap-6">
			<div class="min-w-0">
				<dt class="text-xs font-semibold uppercase tracking-wide text-slate-500">{m['bv7.files_count']()}</dt>
				<dd class="mt-1 font-semibold text-slate-900">{book.files.length}</dd>
			</div>
			<div class="min-w-0">
				<dt class="text-xs font-semibold uppercase tracking-wide text-slate-500">{m['bv7.total_size']()}</dt>
				<dd class="mt-1 break-words font-semibold text-slate-900">{formatSize(model.totalBytes)}</dd>
			</div>
			<div class="min-w-0">
				<dt class="text-xs font-semibold uppercase tracking-wide text-slate-500">{m['bv7.formats']()}</dt>
				<dd class="mt-1 font-semibold text-slate-900">
					{model.formats.length}
					{#if model.formats.length}
						<div class="mt-2 flex h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
							{#each model.formats as format (format.format)}
								<span class={formatTone(format.format)} style={`width: ${format.count / book.files.length * 100}%`}></span>
							{/each}
						</div>
						<ul class="mt-1 flex flex-wrap gap-x-2 text-xs font-normal text-slate-500">
							{#each model.formats as format (format.format)}
								<li>{m['bv7.format_count']({ format: format.format.toUpperCase(), count: String(format.count) })}</li>
							{/each}
						</ul>
					{/if}
				</dd>
			</div>
		</dl>
	</section>
</div>
