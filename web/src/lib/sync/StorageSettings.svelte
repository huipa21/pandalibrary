<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { currentAccount, offlineAvailable, offlineStatus, refreshStatus, syncNow } from './client.js';
	import { discardMutation, downloadedBooks, outbox, removeAllBooks, removeBook } from './db.js';
	import type { DownloadedBook, OutboxEntry, SyncMutation } from './types.js';

	let books = $state<DownloadedBook[]>([]);
	let entries = $state<OutboxEntry[]>([]);
	let usage = $state<number | null>(null);
	let quota = $state<number | null>(null);
	let persistent = $state<boolean | null>(null);
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');
	let refreshVersion = 0;

	onMount(() => {
		let previous: { account: number | null; pending: number; issues: number; syncing: boolean } | null = null;
		const unsubscribe = offlineStatus.subscribe((status) => {
			const changed = previous !== null && status.account !== null &&
				(previous.account !== status.account || previous.pending !== status.pending ||
					previous.issues !== status.issues || (previous.syncing && !status.syncing));
			previous = { account: status.account, pending: status.pending, issues: status.issues, syncing: status.syncing };
			if (changed) void refresh();
		});
		void refresh();
		return () => { refreshVersion += 1; unsubscribe(); };
	});

	async function refresh() {
		if (!offlineAvailable()) return;
		const version = ++refreshVersion;
		try {
			const account = currentAccount();
			const [savedBooks, savedEntries] = await Promise.all([downloadedBooks(account), outbox(account)]);
			if (version !== refreshVersion) return;
			books = savedBooks;
			entries = savedEntries;
			if (navigator.storage?.estimate) {
				const estimate = await navigator.storage.estimate();
				if (version !== refreshVersion) return;
				usage = estimate.usage ?? null;
				quota = estimate.quota ?? null;
			}
			if (navigator.storage?.persisted) {
				const saved = await navigator.storage.persisted();
				if (version !== refreshVersion) return;
				persistent = saved;
			}
			await refreshStatus();
		} catch (cause) {
			console.error('Could not inspect offline storage', cause);
			if (version === refreshVersion) error = m['offline.storage.failure']();
		}
	}

	function formatSize(bytes: number | null): string {
		if (bytes === null || !Number.isFinite(bytes)) return m['offline.storage.unknown']();
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		let size = bytes;
		let unit = 0;
		while (size >= 1024 && unit < units.length - 1) {
			size /= 1024;
			unit += 1;
		}
		return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(size)} ${units[unit]}`;
	}

	async function requestPersistence() {
		error = '';
		if (!navigator.storage?.persist) {
			persistent = null;
			return;
		}
		try {
			persistent = await navigator.storage.persist();
		} catch (cause) {
			console.error('Could not request persistent storage', cause);
			error = m['offline.storage.persist_failed']();
		}
	}

	async function remove(bookId?: number) {
		const confirm = bookId === undefined
			? m['offline.storage.remove_all_confirm']()
			: m['offline.storage.remove_confirm']();
		if (!window.confirm(confirm)) return;
		busy = true;
		error = '';
		notice = '';
		try {
			if (bookId === undefined) await removeAllBooks(currentAccount());
			else await removeBook(currentAccount(), bookId);
			await refresh();
			notice = m['offline.storage.removed']();
		} catch (cause) {
			console.error('Could not remove downloaded books', cause);
			error = m['offline.storage.failure']();
		} finally {
			busy = false;
		}
	}

	async function discard(sequence: number) {
		if (!window.confirm(m['offline.outbox.discard_confirm']())) return;
		busy = true;
		error = '';
		try {
			await discardMutation(currentAccount(), sequence);
			await refresh();
		} catch (cause) {
			console.error('Could not discard the queued change', cause);
			error = m['offline.storage.failure']();
		} finally {
			busy = false;
		}
	}

	async function retry() {
		busy = true;
		error = '';
		try {
			await syncNow(true);
			await refresh();
		} catch (cause) {
			console.error('Could not retry queued changes', cause);
			error = m['offline.status.failed']();
		} finally {
			busy = false;
		}
	}

	function entityLabel(entity: SyncMutation['entity']): string {
		switch (entity) {
			case 'reading_progress': return m['offline.outbox.progress']();
			case 'highlights': return m['offline.outbox.highlight']();
			case 'bookmarks': return m['offline.outbox.bookmark']();
			case 'page_annotations': return m['pv3.outbox.page_annotation']();
			case 'notes': return m['offline.outbox.note']();
			case 'user_settings': return m['offline.outbox.setting']();
			case 'reading_sessions': return m['offline.outbox.session']();
			case 'user_books': return m['offline.outbox.book']();
		}
	}

	function statusLabel(status: OutboxEntry['status']): string {
		switch (status) {
			case 'pending': return m['offline.outbox.pending']();
			case 'applied': return m['offline.outbox.applied']();
			case 'stale': return m['offline.outbox.stale']();
			case 'rejected': return m['offline.outbox.rejected']();
		}
	}

	function queuedBookId(mutation: SyncMutation): number | null {
		const id = mutation.data.book_id;
		return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
	}
</script>

<section aria-labelledby="offline-storage-heading" class="max-w-3xl space-y-5">
	<div>
		<h2 id="offline-storage-heading" class="text-xl font-semibold">{m['offline.storage.title']()}</h2>
		<p class="mt-1 text-sm text-slate-600">{m['offline.storage.description']()}</p>
	</div>
	{#if !$offlineStatus.available}
		<p class="text-amber-800">{m['offline.storage.unavailable']()}</p>
	{:else}
		{#if error}<p role="alert" class="rounded-md bg-red-50 p-3 text-red-800">{error}</p>{/if}
		{#if notice}<p role="status" class="rounded-md bg-green-50 p-3 text-green-800">{notice}</p>{/if}
		<dl class="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
			<dt class="font-medium">{m['offline.storage.usage']()}</dt><dd>{formatSize(usage)}</dd>
			<dt class="font-medium">{m['offline.storage.quota']()}</dt><dd>{formatSize(quota)}</dd>
			<dt class="font-medium">{m['offline.storage.persistence']()}</dt>
			<dd>
				{persistent === null ? m['offline.storage.persistence_unknown']()
					: persistent ? m['offline.storage.persistent']() : m['offline.storage.not_persistent']()}
			</dd>
		</dl>
		{#if typeof navigator !== 'undefined' && typeof navigator.storage?.persist === 'function' && persistent !== true}
			<button class="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium focus-visible:outline-2" onclick={requestPersistence}>
				{m['offline.storage.persist']()}
			</button>
		{/if}

		<div class="space-y-3">
			<h3 class="font-semibold">{m['offline.storage.books']()}</h3>
			{#if books.length}
				<ul class="divide-y divide-slate-200 rounded-md border border-slate-200">
					{#each books as item (item.book.id)}
						<li class="flex flex-wrap items-center justify-between gap-3 p-4">
							<div>
								<a class="font-medium underline-offset-4 hover:underline focus-visible:outline-2" href={`/books/${item.book.id}`}>{item.book.title}</a>
								{#if !item.fileIds.length}<p class="text-sm text-amber-800">{m['offline.storage.files_missing']()}</p>{/if}
							</div>
							<button class="text-sm font-medium text-red-700 underline focus-visible:outline-2" disabled={busy} onclick={() => remove(item.book.id)}>
								{m['offline.storage.remove']()}
							</button>
						</li>
					{/each}
				</ul>
				<button class="rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-700 focus-visible:outline-2" disabled={busy} onclick={() => remove()}>
					{m['offline.storage.remove_all']()}
				</button>
			{:else}
				<p class="text-sm text-slate-600">{m['offline.storage.empty']()}</p>
			{/if}
		</div>

		<div class="space-y-3">
			<h3 class="font-semibold">{m['offline.outbox.title']()}</h3>
			<p class="text-sm text-slate-600">{m['offline.outbox.description']()}</p>
			{#if entries.length}
				<ul class="divide-y divide-slate-200 rounded-md border border-slate-200">
					{#each entries as entry (entry.sequence)}
						{@const bookId = queuedBookId(entry.mutation)}
						<li class="flex flex-wrap items-center justify-between gap-3 p-4">
							<div>
								<p class="font-medium">{entityLabel(entry.mutation.entity)}</p>
								<p class="text-sm text-slate-600">{statusLabel(entry.status)}</p>
								{#if entry.reason}<p class="text-sm text-slate-600">{m['offline.outbox.reason']({ reason: entry.reason })}</p>{/if}
								{#if bookId !== null}<a class="text-sm underline focus-visible:outline-2" href={`/books/${bookId}`}>{m['offline.outbox.book_reference']({ id: bookId })}</a>{/if}
							</div>
							<button class="text-sm font-medium text-red-700 underline focus-visible:outline-2" disabled={busy} onclick={() => discard(entry.sequence)}>
								{m['offline.outbox.discard']()}
							</button>
						</li>
					{/each}
				</ul>
				<button class="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium focus-visible:outline-2" disabled={busy || !$offlineStatus.online} onclick={retry}>
					{m['offline.retry_sync']()}
				</button>
			{:else}
				<p class="text-sm text-slate-600">{m['offline.outbox.empty']()}</p>
			{/if}
		</div>
	{/if}
</section>
