<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { formatDate, formatPercent, formatRelative, formatSize } from '../format.js';
	import Icon from '../Icon.svelte';
	import FileIcon from './FileIcon.svelte';
	import FileMenu from './FileMenu.svelte';
	import ProgressRing from './ProgressRing.svelte';
	import type { FileItem } from './files-model.js';

	interface Props {
		bookId: number;
		file: FileItem;
		primary: boolean;
		progressUpdatedAt: string | null;
		online: boolean;
		offlineAvailable: boolean;
		busy: boolean;
		onSave: (file: FileItem) => void;
		onRemove: (file: FileItem) => void;
		onCopy: (file: FileItem) => void;
	}

	let { bookId, file, primary, progressUpdatedAt, online, offlineAvailable, busy, onSave, onRemove, onCopy }: Props = $props();
</script>

<section class="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6 lg:self-start" aria-labelledby="file-panel-heading">
	<h2 id="file-panel-heading" class="font-semibold uppercase tracking-wide text-slate-900">{m['bv7.this_file']()}</h2>
	<div class="mt-5 flex min-w-0 items-center gap-4">
		<FileIcon format={file.format} size="lg" />
		<div class="min-w-0">
			<h3 class="break-words font-semibold text-slate-900">{file.original_filename}</h3>
			<div class="mt-2 flex flex-wrap gap-1.5">
				{#if primary}<span class="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold uppercase text-emerald-800">{m['bv7.primary']()}</span>{/if}
				{#if file.saved}<span class="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold uppercase text-sky-800">{m['bv7.offline']()}</span>{/if}
			</div>
		</div>
	</div>
	<div class="mt-5">
		<h3 class="text-xs font-semibold uppercase tracking-wide text-slate-500">{m['bv7.file_name']()}</h3>
		<div class="mt-2 flex min-w-0 items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
			<code class="min-w-0 flex-1 break-all text-sm text-slate-700">{file.original_filename}</code>
			<button
				type="button"
				class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-slate-600 hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-emerald-700"
				aria-label={m['bv7.copy_name_for']({ name: file.original_filename })}
				onclick={() => onCopy(file)}
			><Icon name="copy" class="size-4" /></button>
		</div>
	</div>
	<dl class="mt-5 space-y-3 text-sm">
		<div class="flex justify-between gap-4"><dt class="text-slate-500">{m['bv7.size']()}</dt><dd class="font-medium text-slate-900">{formatSize(file.size_bytes)}</dd></div>
		<div class="flex justify-between gap-4"><dt class="text-slate-500">{m['bv7.added']()}</dt><dd class="text-right font-medium text-slate-900">{file.created_at ? formatDate(file.created_at) : m['bv7.unknown_date']()}</dd></div>
	</dl>
	{#if file.progress !== null}
		<div class="mt-5 flex items-center gap-3 rounded-xl bg-emerald-50 p-3">
			<ProgressRing fraction={file.progress} />
			<div class="min-w-0 text-sm">
				<p class="font-medium text-slate-900">{m['bv7.progress']({ percent: formatPercent(file.progress) })}</p>
				{#if progressUpdatedAt}<p class="mt-1 text-slate-600">{m['bv7.last_read']({ relative: formatRelative(progressUpdatedAt) })}</p>{/if}
			</div>
		</div>
	{/if}
	<div class="mt-5 flex items-center gap-2">
		{#if file.readable}
			<a
				class="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg bg-emerald-700 px-3 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
				href={`/read/${bookId}/${file.id}`}
				aria-label={file.progress !== null ? m['bv7.resume_file']({ name: file.original_filename }) : m['bv7.read_file']({ name: file.original_filename })}
			><Icon name="book-open" class="size-4" />{file.progress !== null ? m['bv7.resume']() : m['bv7.read']()}</a>
		{/if}
		{#if online}
			<a
				class="inline-flex size-10 shrink-0 items-center justify-center rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-700"
				href={file.download_url}
				aria-label={m['catalog.book.download']()}
				title={m['catalog.book.download']()}
			><Icon name="download" /></a>
		{/if}
		<FileMenu {file} {online} {offlineAvailable} {busy} {onSave} {onRemove} {onCopy} />
	</div>
</section>
