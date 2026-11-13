<script lang="ts">
	import { onDestroy } from 'svelte';
	import { UPLOAD_ACCEPT } from '#lib/bookheap/upload-queue.svelte.js';
	import type { Book } from '#lib/catalog/types.js';
	import * as m from '#lib/paraglide/messages.js';
	import { offlineStatus } from '#lib/sync/client.js';
	import Icon from '../Icon.svelte';
	import { uploadBookFile, waitForImport } from '../files/files-api.js';

	let { book, offline, onAdded }: {
		book: Book;
		offline: boolean;
		onAdded: () => void | Promise<void>;
	} = $props();
	let input = $state<HTMLInputElement>();
	let busy = $state(false);
	let progress = $state('');
	let notice = $state('');
	let errors = $state<string[]>([]);
	let controller: AbortController | null = null;
	const disconnected = $derived(offline || !$offlineStatus.online);

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
					if (job.status === 'imported') added += 1;
					else if (job.status === 'duplicate') {
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
				await onAdded();
			}
		} finally {
			if (!signal.aborted) {
				busy = false;
				progress = '';
			}
		}
	}

	function choose(event: Event) {
		const target = event.currentTarget as HTMLInputElement;
		const files = [...(target.files ?? [])];
		target.value = '';
		void upload(files);
	}
</script>

<input bind:this={input} type="file" accept={UPLOAD_ACCEPT} multiple hidden onchange={choose} data-testid="add-file-input" />
<button
	type="button"
	class="shell-icon-button size-10 disabled:opacity-60"
	aria-label={m['bv8.add_file']()}
	title={disconnected ? m['bv8.add_file_offline']() : m['bv8.add_file_hint']()}
	disabled={busy || disconnected}
	aria-busy={busy}
	onclick={() => input?.click()}
>
	<Icon name={busy ? 'refresh' : 'upload'} class={busy ? 'size-5 shrink-0 animate-spin motion-reduce:animate-none' : 'size-5 shrink-0'} />
</button>
{#if progress}<p class="basis-full text-xs text-slate-600" role="status">{progress}</p>{/if}
{#if notice}<p class="basis-full text-sm text-emerald-800" role="status">{notice}</p>{/if}
{#each errors as error, index (index)}<p class="basis-full text-sm text-red-800" role="alert">{error}</p>{/each}
