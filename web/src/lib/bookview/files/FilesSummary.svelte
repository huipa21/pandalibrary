<script lang="ts">
	import type { Book } from '#lib/catalog/types.js';
	import { filterControlClass } from '#lib/catalog/filter-styles.js';
	import * as m from '#lib/paraglide/messages.js';
	import BookCover from '../BookCover.svelte';
	import { formatTone } from '../cover.js';
	import { formatSize } from '../format.js';
	import type { FilesModel, FileSort } from './files-model.js';

	interface Props {
		book: Book;
		coverSource: string | null;
		libraryName: string;
		model: FilesModel;
		sort: FileSort;
	}

	let { book, coverSource, libraryName, model, sort = $bindable() }: Props = $props();
	const author = $derived(book.authors.find((item) => item.role === 'author')?.name);
	const primary = $derived(model.groups.flatMap((group) => group.files).find((file) => file.id === model.primaryFileId));
</script>

<section class="card p-4 sm:p-6">
	<h1 class="sr-only">{m['bv7.title']()}</h1>
	<div class="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
		<div class="flex min-w-0 items-center gap-4">
			<div class="w-12 shrink-0">
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
				<h2 class="truncate text-lg font-semibold text-slate-900" title={book.title}>{book.title}</h2>
				<nav aria-label={m['bv7.breadcrumb']()} class="mt-1 flex min-w-0 items-center gap-1.5 text-sm text-slate-500">
					<span class="min-w-0 truncate" title={libraryName}>{libraryName}</span>
					{#if author}<span aria-hidden="true">/</span><span class="min-w-0 truncate" title={author}>{author}</span>{/if}
					{#if primary}<span aria-hidden="true">/</span><span class="min-w-0 truncate" title={primary.original_filename}>{primary.original_filename}</span>{/if}
				</nav>
			</div>
		</div>
		<label class="grid shrink-0 gap-1 text-sm font-medium">
			<span>{m['bv7.sort']()}</span>
			<select bind:value={sort} class="{filterControlClass} min-w-0">
				<option value="format">{m['bv7.sort_format']()}</option>
				<option value="name">{m['bv7.sort_name']()}</option>
				<option value="size">{m['bv7.sort_size']()}</option>
				<option value="added">{m['bv7.sort_added']()}</option>
			</select>
		</label>
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
