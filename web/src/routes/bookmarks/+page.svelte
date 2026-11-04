<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { listBookmarks, bookmarkPositionPercent, bookmarkLabelIssue, MAX_BOOKMARK_LABEL_CHARS } from '#lib/bookmarks/api.js';
	import { saveMutation } from '#lib/sync/client.js';
	import { deleteBookmark, makeBookmark } from '#lib/reader/bookmarks.js';
	import type { Bookmark } from '#lib/reader/types.js';
	import { type Relocation } from '#lib/reader/types.js';

	let bookmarks = $state<Bookmark[]>([]);
	let nextCursor = $state<string | null>(null);
	let loading = $state(true);
	let error = $state('');
	let busy = $state(false);
	let editingId = $state<string | null>(null);
	let editLabel = $state('');
	let editError = $state('');

	const cursor = $derived(page.url.searchParams.get('cursor'));
	const limit = 20;
	const locale = $derived(getLocale());
	const dateFormat = $derived(new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }));

	$effect(() => {
		loadBookmarks();
	});

	async function loadBookmarks() {
		loading = true;
		error = '';
		try {
			const result = await listBookmarks(limit, cursor ?? undefined);
			bookmarks = result.items;
			nextCursor = result.next_cursor;
		} catch (err) {
			console.error('Failed to load bookmarks:', err);
			error = 'Failed to load bookmarks';
		} finally {
			loading = false;
		}
	}

	async function handleDelete(bookmark: Bookmark) {
		if (!window.confirm('Delete this bookmark?')) return;
		busy = true;
		try {
			await saveMutation(deleteBookmark(bookmark.id));
			bookmarks = bookmarks.filter((b) => b.id !== bookmark.id);
		} catch (err) {
			error = 'Failed to delete bookmark';
		} finally {
			busy = false;
		}
	}

	async function handleEditLabel(bookmark: Bookmark) {
		if (!editLabel.trim()) {
			editError = 'Label cannot be empty';
			return;
		}
		if (bookmarkLabelIssue(editLabel)) {
			editError = `Label exceeds ${MAX_BOOKMARK_LABEL_CHARS} bytes`;
			return;
		}
		if (editLabel === bookmark.label) {
			editingId = null;
			return;
		}

		busy = true;
		editError = '';
		try {
			// Create a fake location object for the mutation - we're not changing position
			const location: Relocation = {
				fraction: bookmark.position,
				locator: bookmark.locator as any
			};
			const mutation = makeBookmark(bookmark.book_id, bookmark.book_file_id ?? -1, location, editLabel, bookmark);
			await saveMutation(mutation);
			bookmarks = bookmarks.map((b) => b.id === bookmark.id ? { ...b, label: editLabel, updated_at: new Date().toISOString() } : b);
			editingId = null;
			editLabel = '';
		} catch (err) {
			editError = 'Failed to update bookmark';
		} finally {
			busy = false;
		}
	}

	async function handleJump(bookmark: Bookmark) {
		await goto(`/read/${bookmark.book_id}/${bookmark.book_file_id || 'latest'}`);
	}

	function startEdit(bookmark: Bookmark) {
		editingId = bookmark.id;
		editLabel = bookmark.label;
		editError = '';
	}

	function cancelEdit() {
		editingId = null;
		editLabel = '';
		editError = '';
	}

	async function previousPage() {
		// Simplified - just reload from beginning
		await goto('/bookmarks', { reset: false });
	}

	async function nextPage() {
		if (!nextCursor) return;
		await goto(`/bookmarks?cursor=${encodeURIComponent(nextCursor)}`, { reset: false });
	}
</script>

<main class="space-y-6">
	<header>
		<h1 class="text-3xl font-semibold tracking-tight">Bookmarks</h1>
		<p class="mt-2 text-slate-600">Your saved reading positions</p>
	</header>

	{#if error}
		<div class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">
			<p>{error}</p>
			<button class="mt-2 underline focus-visible:outline-2" onclick={loadBookmarks}>Retry</button>
		</div>
	{/if}

	{#if loading}
		<p class="text-slate-600">Loading bookmarks...</p>
	{:else if bookmarks.length === 0}
		<p class="text-slate-600">No bookmarks saved yet</p>
	{:else}
		<div class="space-y-4">
			{#each bookmarks as bookmark (bookmark.id)}
				<div class="space-y-3 rounded-md border border-slate-200 bg-white p-4">
					{#if editingId === bookmark.id}
						<form class="space-y-3" onsubmit={(e) => { e.preventDefault(); void handleEditLabel(bookmark); }}>
							<input
								type="text"
								class="block w-full rounded-md border border-slate-300 p-2 focus-visible:outline-2"
								placeholder="Label"
								bind:value={editLabel}
								maxlength={MAX_BOOKMARK_LABEL_CHARS}
								disabled={busy}
								autofocus
							/>
							{#if editError}
								<p class="text-sm text-red-600">{editError}</p>
							{/if}
							<div class="flex gap-3">
								<button type="submit" class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline-2" disabled={busy}>
									Save
								</button>
								<button type="button" class="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2" onclick={cancelEdit}>
									Cancel
								</button>
							</div>
						</form>
					{:else}
						<div class="space-y-2">
							<div class="flex items-start justify-between gap-4">
								<div class="min-w-0 flex-1">
									<p class="font-semibold">{bookmark.label || 'Unnamed'}</p>
									<p class="text-sm text-slate-600">
										Position: {(bookmarkPositionPercent(bookmark.position) ?? 0).toFixed(1)}%
										{#if bookmark.chapter}
											— {bookmark.chapter}
										{/if}
									</p>
								</div>
								<time class="whitespace-nowrap text-sm text-slate-600">{dateFormat.format(new Date(bookmark.created_at))}</time>
							</div>
						</div>
						<div class="flex flex-wrap gap-3 text-sm">
							<button class="underline focus-visible:outline-2" disabled={busy} onclick={() => void handleJump(bookmark)}>
								Open
							</button>
							<button class="underline focus-visible:outline-2" disabled={busy} onclick={() => startEdit(bookmark)}>
								Edit
							</button>
							<button class="underline focus-visible:outline-2" disabled={busy} onclick={() => void handleDelete(bookmark)}>
								Delete
							</button>
						</div>
					{/if}
				</div>
			{/each}
		</div>

		{#if cursor || nextCursor}
			<div class="flex justify-between gap-4 pt-4">
				<button
					class="rounded-md border border-slate-300 bg-white px-4 py-2 font-medium focus-visible:outline-2"
					disabled={!cursor}
					onclick={previousPage}
				>
					Previous
				</button>
				<button
					class="rounded-md border border-slate-300 bg-white px-4 py-2 font-medium focus-visible:outline-2"
					disabled={!nextCursor}
					onclick={nextPage}
				>
					Next
				</button>
			</div>
		{/if}
	{/if}
</main>

<style>
	main {
		max-width: 56rem;
		margin: 2rem auto;
		padding: 0 1rem;
	}
</style>
