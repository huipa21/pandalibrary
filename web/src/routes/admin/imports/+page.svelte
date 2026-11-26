<script lang="ts">
	import { showLoadingAfterDelay } from '#lib/ui/deferred.js';
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { ApiError } from '#lib/api/client.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import { ImportHistory } from '#lib/admin/ImportHistory.svelte.js';
	import PagerFooter from '#lib/admin/PagerFooter.svelte';
	import { listImports } from '#lib/admin/api.js';
	import { adminErrorKey } from '#lib/admin/form.js';
	import { formatTimestamp, isActiveImport } from '#lib/admin/jobs.js';
	import { BoundedPoller } from '#lib/admin/poller.js';
	import type { ImportJob } from '#lib/admin/types.js';
	import { focusRing, linkClass, panelClass } from '#lib/admin/ui.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import { controlIconClass } from '#lib/catalog/filter-styles.js';
	import { translate } from '#lib/paging/translate.js';
	import SearchField from '#lib/search/SearchField.svelte';

	const POLL_INTERVAL_MS = 3000;
	const POLL_MAX_TICKS = 100;

	let destroyed = false;
	let query = $state('');
	let activeQuery = $state('');
	const history = new ImportHistory((signal) => listImports({ signal, q: activeQuery }));
	const poller = new BoundedPoller(
		async () => {
			try {
				return await history.refresh();
			} catch (cause) {
				// Keep retrying transient failures within the poll budget, but not lost sessions or permissions.
				return !(cause instanceof ApiError && (cause.status === 401 || cause.status === 403));
			}
		},
		{ intervalMs: POLL_INTERVAL_MS, maxTicks: POLL_MAX_TICKS }
	);

	onMount(() => {
		void history.reset(fetchImports).then(() => {
			if (history.hasActive) startPolling();
		});
	});

	onDestroy(() => {
		destroyed = true;
		poller.stop();
		history.dispose();
	});

	function fetchImports(cursor: string | null, signal: AbortSignal) {
		return listImports({ cursor, signal, q: activeQuery });
	}

	function startPolling() {
		if (!destroyed) poller.start();
	}

	function search(event: SubmitEvent) {
		event.preventDefault();
		activeQuery = query.trim();
		poller.stop();
		void history.reset(fetchImports).then(() => {
			if (history.hasActive) startPolling();
		});
	}

	async function refresh() {
		try {
			if (await history.refresh()) startPolling();
		} catch {
			// The refresh error is shown from history.refreshError.
		}
	}

	function statusLabel(status: string): string {
		switch (status) {
			case 'pending':
				return m['admin.imports.status.pending']();
			case 'processing':
				return m['admin.imports.status.processing']();
			case 'imported':
				return m['admin.imports.status.imported']();
			case 'duplicate':
				return m['admin.imports.status.duplicate']();
			case 'failed':
				return m['admin.imports.status.failed']();
			default:
				return m['admin.imports.status.unknown']({ status });
		}
	}

	function statusClass(status: string): string {
		if (status === 'imported') return 'border-green-300 bg-green-50 text-green-800';
		if (status === 'failed') return 'border-red-300 bg-red-50 text-red-800';
		if (status === 'duplicate') return 'border-amber-300 bg-amber-50 text-amber-900';
		return 'border-slate-300 bg-slate-50 text-slate-700';
	}

	function jobName(job: ImportJob): string {
		return job.book_title || job.original_name;
	}
</script>

<svelte:head>
	<title>{m['admin.imports.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-8" aria-labelledby="imports-heading">
	<h1 id="imports-heading" class="sr-only">{m['admin.imports.title']()}</h1>

	<section class={panelClass} aria-busy={history.status === 'loading'}>
		<div class="flex flex-wrap items-center gap-2">
			<form role="search" aria-label={m['admin.imports.search']()} class="flex w-full min-w-0 max-w-xs sm:max-w-sm" onsubmit={search}>
				<SearchField
					id="admin-imports-search"
					name="q"
					class="min-w-0 flex-1"
					label={m['admin.imports.search']()}
					buttonLabel={m['admin.imports.search']()}
					placeholder={m['admin.imports.search_placeholder']()}
					bind:value={query}
				/>
			</form>
			{#if history.status === 'ready'}
				<button
					type="button"
					class={`ml-auto inline-flex size-9 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:opacity-60 ${focusRing}`}
					aria-label={m['admin.imports.refresh']()}
					title={m['admin.imports.refresh']()}
					disabled={history.refreshing}
					onclick={refresh}
				>
					<Icon name="refresh" class={`${controlIconClass} ${history.refreshing ? 'animate-spin' : ''}`} />
				</button>
			{/if}
		</div>

		{#if history.refreshError}
			<AdminAlert message={translate(adminErrorKey(history.refreshError, 'load'))} error={history.refreshError} onretry={refresh} />
		{/if}
		{#if history.status === 'error'}
			<AdminAlert message={translate(adminErrorKey(history.error, 'load'))} error={history.error} onretry={() => history.retry()} />
		{:else if history.status !== 'ready'}
			<p use:showLoadingAfterDelay class="text-slate-600" role="status">{m['admin.imports.loading']()}</p>
		{:else if history.empty}
			<p class="text-slate-600">{activeQuery ? m['admin.imports.no_matches']() : m['admin.imports.empty']()}</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-left text-sm">
					<thead class="border-b border-slate-200 text-slate-600">
						<tr>
							<th scope="col" class="py-2 pr-4">{m['admin.imports.name']()}</th>
							<th scope="col" class="py-2 pr-4">{m['admin.imports.job']()}</th>
							<th scope="col" class="py-2 pr-4">{m['admin.imports.uploaded_by']()}</th>
							<th scope="col" class="py-2 pr-4">{m['ux8.status']()}</th>
							<th scope="col" class="py-2 pr-4">{m['admin.imports.uploaded_at']()}</th>
						</tr>
					</thead>
					<tbody>
						{#each history.items as job (job.id)}
							<tr class="border-b border-slate-100 last:border-0">
								<td class="py-2 pr-4 font-medium break-words">
									{#if job.book_id !== null && !job.book_deleted}
										<a class={linkClass} href={`/books/${job.book_id}`}>{jobName(job)}</a>
									{:else}
										<span
											class={job.book_deleted ? 'text-red-700 line-through' : ''}
											title={job.book_deleted ? m['admin.imports.deleted_book']() : undefined}
										>{jobName(job)}</span>
									{/if}
								</td>
								<td class="py-2 pr-4 font-mono">#{job.id}</td>
								<td class="py-2 pr-4 font-mono">{job.uploaded_by ?? '—'}</td>
								<td class="py-2 pr-4">
									<span class={`whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${statusClass(job.status)}`}>
										{statusLabel(job.status)}
									</span>
								</td>
								<td class="py-2 pr-4 whitespace-nowrap text-slate-600">
									<time datetime={job.created_at}>{formatTimestamp(job.created_at)}</time>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<PagerFooter pager={history} loadMoreLabel={m['admin.imports.load_more']()} />
		{/if}
	</section>
</section>
