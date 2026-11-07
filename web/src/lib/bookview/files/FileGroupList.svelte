<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { formatSize } from '../format.js';
	import FileRow from './FileRow.svelte';
	import { sortFiles, type FileGroup, type FileItem, type FileSort, type ReaderGroup } from './files-model.js';

	interface Props {
		bookId: number;
		groups: FileGroup[];
		sort: FileSort;
		selectedFileId: number | null;
		online: boolean;
		offlineAvailable: boolean;
		busy: boolean;
		onChoose: (id: number) => void;
		onSave: (file: FileItem) => void;
		onRemove: (file: FileItem) => void;
		onCopy: (file: FileItem) => void;
	}

	let { bookId, groups, sort, selectedFileId, online, offlineAvailable, busy, onChoose, onSave, onRemove, onCopy }: Props = $props();

	function groupLabel(group: ReaderGroup): string {
		switch (group) {
			case 'ebook': return m['bv7.group_ebook']();
			case 'document': return m['bv7.group_document']();
			case 'comic': return m['bv7.group_comic']();
			case 'other': return m['bv7.group_other']();
		}
	}
</script>

<section class="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6" aria-labelledby="files-list-heading">
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<h2 id="files-list-heading" class="font-semibold uppercase tracking-wide text-slate-900">{m['bv7.title']()}</h2>
		<p class="text-sm text-slate-500">{m['bv7.grouped']()}</p>
	</div>
	<div class="mt-5 space-y-6">
		{#each groups as group (group.key)}
			<section aria-labelledby={`file-group-${group.key}`}>
				<div class="mb-2 flex items-center justify-between gap-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
					<h3 id={`file-group-${group.key}`} class="flex items-center gap-2">
						<span class="size-2 rounded-full bg-emerald-600" aria-hidden="true"></span>{groupLabel(group.key)}
					</h3>
					<span class="shrink-0">{m['bv7.group_size']({ count: String(group.count), size: formatSize(group.bytes) })}</span>
				</div>
				<ul class="space-y-1">
					{#each sortFiles(group.files, sort) as file (file.id)}
						<FileRow
							{bookId} {file} selected={file.id === selectedFileId} {online} {offlineAvailable} {busy}
							{onChoose} {onSave} {onRemove} {onCopy}
						/>
					{/each}
				</ul>
			</section>
		{/each}
	</div>
</section>
