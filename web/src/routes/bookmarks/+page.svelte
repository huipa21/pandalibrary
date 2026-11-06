<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { bookmarkLabelIssue, bookmarkPositionPercent, listBookmarks, type BookmarkItem } from '#lib/bookmarks/api.js';
	import { localBookmarks } from '#lib/bookmarks/offline.js';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { deleteBookmark, updateBookmarkLabel } from '#lib/reader/bookmarks.js';
	import { SyncError } from '#lib/reader/api.js';
	import { offlineStatus, saveMutation } from '#lib/sync/client.js';

	const bookmarks = new CursorPager<BookmarkItem>();
	let offline = $state(false);
	let busy = $state(false);
	let editingId = $state<string | null>(null);
	let editLabel = $state('');
	let editError = $state('');
	let actionError = $state('');
	let notice = $state('');
	let source = '';
	const dateFormat = $derived(new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }));

	onMount(() => offlineStatus.subscribe((status) => {
		if (status.account === null) return;
		const key = `${status.account}:${status.online}`;
		if (key === source) return;
		source = key;
		offline = !status.online;
		editingId = null;
		notice = '';
		actionError = '';
		const account = status.account;
		void bookmarks.reset(offline
			? async () => ({ items: await localBookmarks(account), next_cursor: null })
			: (cursor, signal) => listBookmarks(20, cursor ?? undefined, undefined, signal));
	}));
	onDestroy(() => bookmarks.dispose());

	function mutationError(cause: unknown): string {
		console.error('Bookmark change failed', cause);
		return cause instanceof SyncError ? m['ux6.conflict']() : m['ux6.change_failed']();
	}

	async function remove(bookmark: BookmarkItem) {
		if (busy || !window.confirm(m['ux6.delete_confirm']())) return;
		busy = true;
		notice = '';
		actionError = '';
		try {
			const result = await saveMutation(deleteBookmark(bookmark.id));
			bookmarks.items = bookmarks.items.filter((item) => item.id !== bookmark.id);
			if (editingId === bookmark.id) editingId = null;
			notice = result === 'queued' ? m['ux6.queued']() : m['ux6.deleted']();
		} catch (cause) {
			actionError = mutationError(cause);
		} finally {
			busy = false;
		}
	}

	async function saveLabel(bookmark: BookmarkItem) {
		if (busy) return;
		if (bookmarkLabelIssue(editLabel)) {
			editError = m['ux6.limit']();
			return;
		}
		if (editLabel === bookmark.label) {
			editingId = null;
			return;
		}
		busy = true;
		editError = '';
		actionError = '';
		notice = '';
		try {
			const mutation = updateBookmarkLabel(bookmark, editLabel);
			const result = await saveMutation(mutation);
			bookmarks.items = bookmarks.items.map((item) => item.id === bookmark.id
				? { ...item, label: editLabel, updated_at: new Date(mutation.updated_at).toISOString() }
				: item);
			editingId = null;
			editLabel = '';
			notice = result === 'queued' ? m['ux6.queued']() : m['ux6.saved']();
		} catch (cause) {
			editError = mutationError(cause);
		} finally {
			busy = false;
		}
	}

	function startEdit(bookmark: BookmarkItem) {
		editingId = bookmark.id;
		editLabel = bookmark.label;
		editError = '';
	}
</script>

<svelte:head>
	<title>{m['ux6.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-6" aria-labelledby="bookmarks-heading">
	<h1 id="bookmarks-heading" class="sr-only">{m['ux6.title']()}</h1>
	{#if offline}<p class="rounded-md bg-amber-50 p-3 text-sm text-amber-950" role="status">{m['ux6.offline_list']()}</p>{/if}
	{#if notice}<p class="text-sm text-green-700" role="status">{notice}</p>{/if}
	{#if actionError}<p class="rounded-md bg-red-50 p-3 text-red-800" role="alert">{actionError}</p>{/if}

	{#if bookmarks.status === 'error'}
		<div class="rounded-md border border-red-200 bg-red-50 p-4 text-red-800" role="alert">
			<p>{m['ux6.load_failed']()}</p>
			<button class="mt-2 underline focus-visible:outline-2" onclick={() => bookmarks.retry()}>{m['ux6.retry']()}</button>
		</div>
	{:else if bookmarks.status !== 'ready'}
		<p class="text-slate-600" role="status">{m['ux6.loading']()}</p>
	{:else}
		{#if bookmarks.empty}
			<p class="text-slate-600">{m['ux6.empty']()}</p>
		{:else}
			<ul class="space-y-4">
				{#each bookmarks.items as bookmark (bookmark.id)}
					<li class="flex gap-4 rounded-md border border-slate-200 bg-white p-4">
						{#if bookmark.book?.cover_url}
							<img src={bookmark.book.cover_url} alt="" class="h-24 w-16 shrink-0 rounded object-cover" />
						{:else}
							<div class="h-24 w-16 shrink-0 rounded bg-slate-100" aria-hidden="true"></div>
						{/if}
						<div class="min-w-0 flex-1 space-y-2">
							<h2 class="font-semibold break-words">{bookmark.book?.title || m['ux6.book_unavailable']()}</h2>
							{#if editingId === bookmark.id}
								<form class="space-y-2" onsubmit={(event) => { event.preventDefault(); void saveLabel(bookmark); }}>
									<label for="bookmark-label" class="block text-sm font-medium">{m['ux6.label']()}</label>
									<input id="bookmark-label" type="text" class="block w-full rounded-md border border-slate-300 p-2 focus-visible:outline-2"
										bind:value={editLabel} maxlength="512" disabled={busy} {@attach (input) => input.focus()} />
									{#if editError}<p class="text-sm text-red-700" role="alert">{editError}</p>{/if}
									<div class="flex gap-3">
										<button type="submit" class="rounded-md bg-slate-900 px-3 py-2 text-sm text-white" disabled={busy}>{m['ux6.save']()}</button>
										<button type="button" class="rounded-md border border-slate-300 px-3 py-2 text-sm" disabled={busy} onclick={() => (editingId = null)}>{m['ux6.cancel']()}</button>
									</div>
								</form>
							{:else}
								<p>{bookmark.label || m['ux6.unnamed']()}</p>
								<p class="text-sm text-slate-600">
									{m['ux6.position']({ position: (bookmarkPositionPercent(bookmark.position) ?? 0).toFixed(1) })}
									{#if bookmark.chapter} — {bookmark.chapter}{/if}
								</p>
								<time class="block text-sm text-slate-600" datetime={bookmark.created_at}>{dateFormat.format(new Date(bookmark.created_at))}</time>
								{#if bookmark.book_file_id === null || (offline && !bookmark.availableOffline)}
									<p class="text-sm text-amber-800">{m['ux6.unavailable']()}</p>
								{/if}
								<div class="flex flex-wrap gap-3 text-sm">
									{#if bookmark.book_file_id !== null && (!offline || bookmark.availableOffline)}
										<a class="underline focus-visible:outline-2" href={`/read/${bookmark.book_id}/${bookmark.book_file_id}?bookmark=${encodeURIComponent(bookmark.id)}`}>{m['ux6.open']()}</a>
									{/if}
									<button class="underline focus-visible:outline-2" disabled={busy || bookmark.book_file_id === null} onclick={() => startEdit(bookmark)}>{m['ux6.edit']()}</button>
									<button class="underline focus-visible:outline-2" disabled={busy} onclick={() => remove(bookmark)}>{m['ux6.delete']()}</button>
								</div>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
		{#if bookmarks.moreError}
			<p class="text-red-700" role="alert">{m['ux6.load_failed']()}</p>
		{/if}
		{#if bookmarks.hasMore}
			<button class="rounded-md border border-slate-300 bg-white px-4 py-2 focus-visible:outline-2" disabled={bookmarks.loadingMore} onclick={() => bookmarks.loadMore()}>
				{bookmarks.loadingMore ? m['ux6.loading']() : m['ux6.load_more']()}
			</button>
		{/if}
	{/if}
</section>
