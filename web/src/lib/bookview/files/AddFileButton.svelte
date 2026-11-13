<script lang="ts">
	import { onDestroy } from 'svelte';
	import HeapDialog from '#lib/bookheap/HeapDialog.svelte';
	import { UPLOAD_ACCEPT, MAX_UPLOAD_BYTES, fileKey, filesFromDataTransfer, formatBytes, hasSupportedExtension } from '#lib/bookheap/upload-queue.svelte.js';
	import type { Book } from '#lib/catalog/types.js';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { offlineStatus } from '#lib/sync/client.js';
	import Icon from '../Icon.svelte';
	import { uploadBookFile, waitForImport } from './files-api.js';

	let { book, offline, onAdded }: {
		book: Book;
		offline: boolean;
		onAdded: () => void | Promise<void>;
	} = $props();
	let input = $state<HTMLInputElement>();
	let open = $state(false);
	let pending = $state<File[]>([]);
	let validation = $state<string[]>([]);
	let dragging = $state(false);
	let busy = $state(false);
	let progress = $state('');
	let notice = $state('');
	let errors = $state<string[]>([]);
	let controller: AbortController | null = null;
	const dialogId = $props.id();
	const disconnected = $derived(offline || !$offlineStatus.online);
	const limit = formatBytes(MAX_UPLOAD_BYTES, getLocale());

	onDestroy(() => controller?.abort());

	async function upload(files: File[]) {
		if (!files.length || busy || disconnected) return;
		const bookId = book.id;
		controller = new AbortController();
		const signal = controller.signal;
		busy = true;
		notice = '';
		errors = [];
		let added = 0;
		try {
			for (const [index, file] of files.entries()) {
				progress = m['bv8.add_file_progress']({ name: file.name, current: String(index + 1), total: String(files.length) });
				try {
					const job = await waitForImport(await uploadBookFile(bookId, file, { signal }), { signal });
					if (job.status === 'imported') {
						added += 1;
						pending = pending.filter((item) => fileKey(item) !== fileKey(file));
					} else if (job.status === 'duplicate') {
						errors.push(job.duplicate_of_book_id === bookId
							? m['bv8.add_file_already_attached']({ name: file.name })
							: m['bv8.add_file_duplicate']({ name: file.name }));
					} else {
						errors.push(m['bv8.add_file_failed']({ name: file.name, reason: job.error ?? job.status }));
					}
				} catch (cause) {
					if (signal.aborted) return;
					console.error('Could not add a file to the book', cause);
					errors.push(m['bv8.add_file_failed']({ name: file.name, reason: cause instanceof Error ? cause.message : String(cause) }));
				}
			}
			if (added && book.id === bookId) {
				notice = m['bv8.add_file_success']({ count: String(added) });
				try {
					await onAdded();
				} catch (cause) {
					console.error('Could not refresh the book after adding files', cause);
					errors.push(m['bv8.add_file_refresh_failed']());
				}
			}
		} finally {
			if (!signal.aborted) {
				busy = false;
				progress = '';
			}
		}
	}

	function add(files: File[], ignored = 0) {
		if (busy || disconnected) return;
		validation = [];
		notice = '';
		const known = new Set(pending.map(fileKey));
		for (const file of files) {
			if (!hasSupportedExtension(file.name)) {
				validation.push(m['bh3.notice_unsupported']({ names: file.name }));
			} else if (file.size > MAX_UPLOAD_BYTES) {
				validation.push(m['bh3.notice_too_large']({ limit, names: file.name }));
			} else if (file.size === 0) {
				validation.push(m['bv8.add_file_empty']({ name: file.name }));
			} else if (known.has(fileKey(file))) {
				validation.push(m['bv8.add_file_selected']({ name: file.name }));
			} else {
				known.add(fileKey(file));
				pending.push(file);
			}
		}
		if (ignored) validation.push(m['bh3.notice_ignored']());
	}

	function choose() {
		if (!input) return;
		add(Array.from(input.files ?? []));
		input.value = '';
	}

	function drop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		const { files, ignored } = filesFromDataTransfer(event.dataTransfer);
		add(files, ignored);
	}
</script>

<div class="min-w-0 space-y-2">
	<button
		type="button"
		class="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:opacity-60"
		title={disconnected ? m['bv8.add_file_offline']() : m['bv8.add_file_hint']()}
		disabled={disconnected}
		onclick={() => { open = true; }}
	>
		<Icon name="upload" class="size-4" />{m['bv8.add_file']()}
	</button>
	{#if notice && !open}<p class="text-sm text-emerald-800" role="status">{notice}</p>{/if}
</div>

<HeapDialog {open} id={dialogId} title={m['bv8.add_file']()} {busy} initialFocus="[data-select-files]" onclose={() => { open = false; }}>
	<p class="mt-1 text-sm text-slate-600">{m['bv8.add_file_review']({ title: book.title })}</p>
	<div
		role="group"
		aria-label={m['bh3.drop_zone']()}
		class={`mt-4 flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-6 text-center ${dragging ? 'border-emerald-500 bg-emerald-50' : 'border-slate-300 bg-slate-50'}`}
		ondragover={(event) => { event.preventDefault(); dragging = true; }}
		ondragleave={() => { dragging = false; }}
		ondrop={drop}
	>
		<Icon name="upload" class="size-8 text-slate-500" />
		<p class="text-sm font-medium">{m['bh3.drop_zone']()}</p>
		<p class="text-xs text-slate-500">{m['bh3.drop_hint']({ limit })}</p>
		<input bind:this={input} type="file" accept={UPLOAD_ACCEPT} multiple hidden onchange={choose} data-testid="add-file-input" />
		<button type="button" data-select-files class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-60" disabled={busy || disconnected} onclick={() => input?.click()}>{m['bh3.select']()}</button>
	</div>
	{#each validation as message, index (index)}<p class="mt-2 text-sm text-red-800" role="alert">{message}</p>{/each}
	{#if pending.length}
		<ul class="mt-4 divide-y divide-slate-100">
			{#each pending as file (fileKey(file))}
				<li class="flex min-w-0 items-center gap-3 py-3">
					<Icon name="file" class="size-5 shrink-0 text-slate-500" />
					<div class="min-w-0 flex-1">
						<p class="break-all text-sm font-medium">{file.name}</p>
						<p class="text-xs text-slate-500">{formatBytes(file.size, getLocale())}</p>
					</div>
					<button type="button" class="shell-icon-button size-8 shrink-0" aria-label={m['bh3.remove']({ name: file.name })} disabled={busy} onclick={() => { pending = pending.filter((item) => fileKey(item) !== fileKey(file)); }}><Icon name="x" class="size-4" /></button>
				</li>
			{/each}
		</ul>
	{/if}
	{#if progress}<p class="mt-3 text-sm text-slate-600" role="status">{progress}</p>{/if}
	{#if notice}<p class="mt-3 text-sm text-emerald-800" role="status">{notice}</p>{/if}
	{#each errors as error, index (index)}<p class="mt-2 text-sm text-red-800" role="alert">{error}</p>{/each}
	{#if disconnected}<p class="mt-2 text-sm text-amber-800" role="alert">{m['bv8.add_file_offline']()}</p>{/if}
	<div class="mt-5 flex justify-end gap-3 border-t border-slate-200 pt-4">
		<button type="button" class="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-60" disabled={busy} onclick={() => { open = false; }}>{m['bh3.close']()}</button>
		<button type="button" class="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60" disabled={busy || disconnected || !pending.length} aria-busy={busy} onclick={() => void upload([...pending])}>
			{#if busy}<Icon name="refresh" class="size-4 animate-spin motion-reduce:animate-none" />{/if}
			{busy ? m['bh3.uploading']() : m['bh3.upload']()}
		</button>
	</div>
</HeapDialog>
