<script lang="ts">
	import { onDestroy } from 'svelte';
	import { ApiError } from '#lib/api/client.js';
	import HeapDialog from '#lib/bookheap/HeapDialog.svelte';
	import { listAllLibraries, moveBook } from '#lib/catalog/api.js';
	import { filterControlClass } from '#lib/catalog/filter-styles.js';
	import type { Book, Library } from '#lib/catalog/types.js';
	import * as m from '#lib/paraglide/messages.js';
	import { notifyBooksChanged } from '#lib/catalog/events.js';
	import Icon from '../Icon.svelte';

	let { book, offline, onMoved }: {
		book: Book;
		offline: boolean;
		onMoved: (updated: Book) => void;
	} = $props();
	const dialogId = $props.id();
	let open = $state(false);
	let loading = $state(false);
	let busy = $state(false);
	let libraries = $state<Library[]>([]);
	let destination = $state('');
	let error = $state('');
	let notice = $state('');
	let controller: AbortController | null = null;
	onDestroy(() => controller?.abort());

	async function load() {
		controller?.abort();
		const request = new AbortController();
		controller = request;
		loading = true;
		libraries = [];
		error = '';
		try {
			const items = await listAllLibraries(request.signal);
			if (request.signal.aborted) return;
			libraries = items.filter((library) => library.id !== book.library_id);
		} catch (cause) {
			if (request.signal.aborted) return;
			console.error('Could not load destination libraries', cause);
			error = m['bv7.move_load_failure']();
		} finally {
			if (!request.signal.aborted) loading = false;
		}
	}

	function close() {
		open = false;
		controller?.abort();
	}

	async function move() {
		if (busy || offline || !destination) return;
		const libraryId = Number(destination);
		busy = true;
		error = '';
		try {
			const library = libraries.find((item) => item.id === libraryId);
			if (!library) throw new Error('The selected destination library is unavailable.');
			const updated = await moveBook(book.id, libraryId);
			onMoved(updated);
			notice = m['bv7.move_success']({ library: library.name });
			notifyBooksChanged();
			window.dispatchEvent(new Event('pandalibrary-libraries-changed'));
			close();
		} catch (cause) {
			console.error('Could not move the book', cause);
			error = cause instanceof ApiError && cause.problem?.detail ? cause.problem.detail : m['bv7.move_failure']();
		} finally {
			busy = false;
		}
	}
</script>

<button type="button" class="shell-icon-button" disabled={offline} aria-label={m['bv7.move_book']()} title={m['bv7.move_book']()} onclick={() => { open = true; destination = ''; notice = ''; void load(); }}>
	<Icon name="move" />
</button>
{#if notice}<p role="status" class="text-sm text-emerald-800">{notice}</p>{/if}
<HeapDialog {open} id={dialogId} title={m['bv7.move_book']()} {busy} onclose={close}>
	<p class="mt-3 text-sm text-slate-600">{m['bv7.move_description']({ title: book.title })}</p>
	{#if loading}
		<p role="status" class="mt-3 text-sm text-slate-600">{m['catalog.loading']()}</p>
	{:else if !error && !libraries.length}
		<p role="status" class="mt-3 text-sm text-slate-600">{m['bv7.move_empty']()}</p>
	{/if}
	<label class="mt-4 grid gap-2 text-sm font-medium">
		<span>{m['bv7.move_destination']()}</span>
		<select class={filterControlClass} bind:value={destination} disabled={loading || busy || offline}>
			<option value="">{m['bv7.move_choose']()}</option>
			{#each libraries as library (library.id)}<option value={String(library.id)}>{library.name}</option>{/each}
		</select>
	</label>
	{#if error}
		<p role="alert" class="mt-3 text-sm text-red-800">{error}</p>
		{#if !libraries.length}<button type="button" class="mt-2 text-sm underline" disabled={loading || offline} onclick={() => void load()}>{m['catalog.retry']()}</button>{/if}
	{/if}
	<div class="mt-5 flex justify-end gap-3 border-t border-slate-200 pt-4">
		<button type="button" class="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-60" disabled={busy} onclick={close}>{m['bh3.close']()}</button>
		<button type="button" class="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60" disabled={busy || loading || offline || !destination} aria-busy={busy} onclick={() => void move()}>{m['bv7.move_book']()}</button>
	</div>
</HeapDialog>
