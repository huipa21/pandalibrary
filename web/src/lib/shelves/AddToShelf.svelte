<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { translate } from '#lib/paging/translate.js';
	import { addBookToShelf, getSessionViewer, listAllShelves } from './api.js';
	import { offersShelfManagement, shelfErrorKey } from './form.js';
	import type { Shelf } from './types.js';

	let { bookId }: { bookId: number } = $props();
	let shelves = $state<Shelf[]>([]);
	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let loadError = $state('');
	let selected = $state('');
	let busy = $state(false);
	let notice = $state('');
	let error = $state('');
	let controller: AbortController | null = null;

	onMount(() => void load());
	onDestroy(() => controller?.abort());

	async function load() {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		status = 'loading';
		loadError = '';
		try {
			const [all, viewer] = await Promise.all([listAllShelves(current.signal), getSessionViewer()]);
			if (current.signal.aborted) return;
			shelves = all.filter((shelf) =>
				offersShelfManagement(shelf, viewer) && shelf.mode !== 'automatic' && shelf.system_key !== 'unshelved'
			);
			if (!shelves.some((shelf) => String(shelf.id) === selected)) selected = '';
			status = 'ready';
		} catch (cause) {
			if (current.signal.aborted) return;
			loadError = translate(shelfErrorKey(cause, 'load'));
			status = 'error';
		}
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const shelf = shelves.find((item) => String(item.id) === selected);
		if (!shelf || busy) return;
		busy = true;
		notice = '';
		error = '';
		try {
			await addBookToShelf(shelf.id, bookId);
			window.dispatchEvent(new CustomEvent('pandalibrary-shelves-changed'));
			notice = m['shelves.book.added']({ name: shelf.name });
		} catch (cause) {
			error = translate(shelfErrorKey(cause, 'add_book'));
		} finally {
			busy = false;
		}
	}
</script>

<section aria-labelledby="book-shelves-heading" class="space-y-3">
	<h2 id="book-shelves-heading" class="text-xl font-semibold">{m['shelves.book.heading']()}</h2>
	{#if status === 'loading'}
		<p class="text-sm text-slate-600" role="status">{m['shelves.book.loading']()}</p>
	{:else if status === 'error'}
		<div class="flex flex-wrap items-center gap-3 text-sm text-red-800" role="alert">
			<p>{loadError}</p>
			<button class="underline underline-offset-4 focus-visible:outline-2" onclick={load}>{m['shelves.retry']()}</button>
		</div>
	{:else if shelves.length === 0}
		<p class="text-sm text-slate-600">
			{m['shelves.book.none']()}
			<a class="ml-1 underline underline-offset-4 focus-visible:outline-2" href="/shelves">{m['shelves.book.create_link']()}</a>
		</p>
	{:else}
		<form class="flex flex-wrap items-end gap-3" onsubmit={submit}>
			<label class="grid gap-1 text-sm font-medium" for="add-to-shelf">
				<span>{m['shelves.book.select']()}</span>
				<select
					id="add-to-shelf"
					class="min-w-48 rounded-md border border-slate-300 bg-white px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
					bind:value={selected}
				>
					<option value="">{m['shelves.book.choose']()}</option>
					{#each shelves as shelf (shelf.id)}
						<option value={String(shelf.id)}>
							{shelf.name} ({shelf.kind === 'shared' ? m['shelves.kind.shared']() : m['shelves.kind.private']()})
						</option>
					{/each}
				</select>
			</label>
			<button
				type="submit"
				class="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-60"
				disabled={!selected || busy}
			>{busy ? m['shelves.book.adding']() : m['shelves.book.add']()}</button>
		</form>
	{/if}
	{#if notice}<p class="text-sm text-green-700" role="status">{notice}</p>{/if}
	{#if error}<p class="text-sm text-red-800" role="alert">{error}</p>{/if}
</section>
