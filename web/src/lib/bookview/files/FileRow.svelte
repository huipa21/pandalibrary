<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { formatPercent, formatSize } from '../format.js';
	import FileIcon from './FileIcon.svelte';
	import FileMenu from './FileMenu.svelte';
	import { splitFileName, type FileItem } from './files-model.js';

	interface Props {
		bookId: number;
		file: FileItem;
		selected: boolean;
		online: boolean;
		offlineAvailable: boolean;
		busy: boolean;
		onChoose: (id: number) => void;
		onSave: (file: FileItem) => void;
		onRemove: (file: FileItem) => void;
		onCopy: (file: FileItem) => void;
	}

	let { bookId, file, selected, online, offlineAvailable, busy, onChoose, onSave, onRemove, onCopy }: Props = $props();
	const name = $derived(splitFileName(file.original_filename));
</script>

<li class={`flex min-w-0 flex-wrap items-center gap-2 rounded-xl p-2 sm:p-3 ${selected ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}>
	<button
		type="button"
		class="flex min-w-[10rem] flex-1 items-center gap-3 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-emerald-700"
		aria-label={m['bv7.select_file']({ name: file.original_filename })}
		aria-pressed={selected}
		onclick={() => onChoose(file.id)}
	>
		<FileIcon format={file.format} />
		<span class="min-w-0">
			<span class="block truncate font-medium text-slate-900" title={file.original_filename}>{name.stem}<span class="text-slate-400">{name.extension}</span></span>
			<span class="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
				{#if file.is_default}
					<span class="rounded-full bg-amber-100 px-2 py-0.5 font-semibold uppercase text-amber-800">{m['bv8.default']()}</span>
				{/if}
				{#if file.progress !== null}
					<span class="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold uppercase text-emerald-800">{m['bv7.read_percent']({ percent: formatPercent(file.progress) })}</span>
				{/if}
				<span>{formatSize(file.size_bytes)}</span>
			</span>
		</span>
	</button>
	<div class="ml-auto flex shrink-0 items-center gap-1">
		{#if file.readable}
			<a
				class="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
				href={`/read/${bookId}/${file.id}`}
				aria-label={file.progress !== null ? m['bv7.resume_file']({ name: file.original_filename }) : m['bv7.read_file']({ name: file.original_filename })}
			>{file.progress !== null ? m['bv7.resume']() : m['bv7.read']()}</a>
		{/if}
		<FileMenu {file} {online} {offlineAvailable} {busy} {onSave} {onRemove} {onCopy} />
	</div>
</li>
