<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { ApiError } from '#lib/api/client.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import { ImportHistory } from '#lib/admin/ImportHistory.svelte.js';
	import PagerFooter from '#lib/admin/PagerFooter.svelte';
	import { listAllAdminLibraries, listImports, uploadBook } from '#lib/admin/api.js';
	import { adminErrorKey, parsePositiveID } from '#lib/admin/form.js';
	import { formatTimestamp, isActiveImport } from '#lib/admin/jobs.js';
	import { BoundedPoller } from '#lib/admin/poller.js';
	import type { ImportJob, Library } from '#lib/admin/types.js';
	import { errorBox, focusRing, inputClass, linkClass, panelClass, primaryButton, secondaryButton } from '#lib/admin/ui.js';
	import { translate } from '#lib/paging/translate.js';

	const POLL_INTERVAL_MS = 3000;
	const POLL_MAX_TICKS = 100;

	const history = new ImportHistory();
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
	let destroyed = false;

	let libraries = $state<Library[]>([]);
	let librariesStatus = $state<'loading' | 'ready' | 'error'>('loading');
	let librariesError = $state<unknown>(null);
	let libraryID = $state('');
	let file = $state<File | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);
	let libraryError = $state('');
	let fileError = $state('');
	let uploadError = $state('');
	let uploading = $state(false);
	let uploaded = $state<ImportJob | null>(null);

	const libraryNames = $derived(new Map(libraries.map((library) => [library.id, library.name])));

	onMount(() => {
		void loadLibraries();
		void history.reset((cursor, signal) => listImports({ cursor, signal })).then(() => {
			if (history.hasActive) startPolling();
		});
	});

	onDestroy(() => {
		destroyed = true;
		poller.stop();
		history.dispose();
	});

	function startPolling() {
		if (!destroyed) poller.start();
	}

	async function loadLibraries() {
		librariesStatus = 'loading';
		librariesError = null;
		try {
			libraries = await listAllAdminLibraries();
			if (libraries.length === 1) libraryID = String(libraries[0].id);
			librariesStatus = 'ready';
		} catch (cause) {
			librariesError = cause;
			librariesStatus = 'error';
		}
	}

	function chooseFile(event: Event) {
		const files = (event.currentTarget as HTMLInputElement).files;
		file = files && files.length > 0 ? files[0] : null;
		fileError = '';
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (uploading) return;
		libraryError = '';
		fileError = '';
		uploadError = '';
		const id = parsePositiveID(libraryID);
		if (id === null) libraryError = m['admin.imports.error.library_required']();
		if (!file) fileError = m['admin.imports.error.file_required']();
		else if (file.size === 0) fileError = m['admin.imports.error.file_empty']();
		if (id === null || !file || file.size === 0) return;

		uploading = true;
		uploaded = null;
		try {
			const job = await uploadBook(id, file);
			uploaded = job;
			file = null;
			if (fileInput) fileInput.value = '';
			history.include(job);
			if (isActiveImport(job)) startPolling();
		} catch (cause) {
			uploadError = translate(adminErrorKey(cause, 'upload'));
		} finally {
			uploading = false;
		}
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

	function sourceLabel(source: string): string {
		if (source === 'upload') return m['admin.imports.source.upload']();
		if (source === 'drop_folder') return m['admin.imports.source.drop_folder']();
		if (source === 'bookheap') return m['bh5.imports.source.bookheap']();
		return source;
	}

	function libraryLabel(id: number): string {
		return libraryNames.get(id) ?? m['admin.libraries.id']({ id });
	}
</script>

<svelte:head>
	<title>{m['admin.imports.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-8" aria-labelledby="imports-heading">
	<header class="space-y-2">
		<h1 id="imports-heading" class="text-3xl font-semibold tracking-tight">{m['admin.imports.title']()}</h1>
		<p class="text-slate-600">{m['admin.imports.description']()}</p>
	</header>

	<section class={panelClass} aria-labelledby="upload-heading">
		<h2 id="upload-heading" class="text-xl font-semibold">{m['admin.imports.upload_heading']()}</h2>
		{#if librariesStatus === 'error'}
			<AdminAlert message={translate(adminErrorKey(librariesError, 'load_libraries'))} error={librariesError} onretry={loadLibraries} />
		{:else if librariesStatus === 'loading'}
			<p class="text-slate-600" role="status">{m['admin.libraries.loading']()}</p>
		{:else if libraries.length === 0}
			<p class="text-slate-600">
				{m['admin.imports.no_libraries']()}
				<a class={linkClass} href="/admin/libraries">{m['admin.tabs.libraries']()}</a>
			</p>
		{:else}
			<form class="grid gap-4" onsubmit={submit} novalidate>
				<div class="grid gap-1">
					<label class="text-sm font-medium" for="upload-library">{m['admin.imports.library']()}</label>
					<select
						id="upload-library"
						class={`${inputClass} sm:max-w-sm`}
						required
						aria-invalid={libraryError ? 'true' : undefined}
						aria-describedby={libraryError ? 'upload-library-error' : undefined}
						bind:value={libraryID}
						onchange={() => (libraryError = '')}
					>
						<option value="" disabled>{m['admin.imports.library_placeholder']()}</option>
						{#each libraries as library (library.id)}
							<option value={String(library.id)}>{library.name}</option>
						{/each}
					</select>
					{#if libraryError}<p id="upload-library-error" class="text-sm text-red-700">{libraryError}</p>{/if}
				</div>
				<div class="grid gap-1">
					<label class="text-sm font-medium" for="upload-file">{m['admin.imports.file']()}</label>
					<input
						id="upload-file"
						type="file"
						class={`text-sm file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1 ${focusRing}`}
						accept=".epub,.pdf,.mobi,.azw3,.fb2,.fbz,.cbz"
						required
						aria-invalid={fileError ? 'true' : undefined}
						aria-describedby={`upload-file-hint${fileError ? ' upload-file-error' : ''}`}
						bind:this={fileInput}
						onchange={chooseFile}
					/>
					<p id="upload-file-hint" class="text-xs text-slate-500">{m['admin.imports.file_hint']()}</p>
					{#if fileError}<p id="upload-file-error" class="text-sm text-red-700">{fileError}</p>{/if}
				</div>
				{#if uploadError}<p class={errorBox} role="alert">{uploadError}</p>{/if}
				<div>
					<button type="submit" class={primaryButton} disabled={uploading}>
						{uploading ? m['admin.imports.uploading']() : m['admin.imports.upload']()}
					</button>
				</div>
			</form>
			{#if uploaded}
				<p class="text-sm text-green-700" role="status">
					{m['admin.imports.accepted']({ id: uploaded.id, name: uploaded.original_name, status: statusLabel(uploaded.status) })}
				</p>
			{/if}
		{/if}
	</section>

	<section class="space-y-4" aria-labelledby="history-heading" aria-busy={history.status === 'loading'}>
		<div class="flex flex-wrap items-center justify-between gap-3">
			<h2 id="history-heading" class="text-xl font-semibold">{m['admin.imports.history_heading']()}</h2>
			{#if history.status === 'ready'}
				<button type="button" class={secondaryButton} disabled={history.refreshing} onclick={refresh}>
					{history.refreshing ? m['admin.imports.refreshing']() : m['admin.imports.refresh']()}
				</button>
			{/if}
		</div>
		{#if history.status === 'ready' && history.hasActive}
			<p class="text-sm text-slate-600" role="status">{m['admin.imports.auto_refresh']()}</p>
		{/if}
		{#if history.refreshError}
			<AdminAlert message={translate(adminErrorKey(history.refreshError, 'load'))} error={history.refreshError} onretry={refresh} />
		{/if}
		{#if history.status === 'error'}
			<AdminAlert message={translate(adminErrorKey(history.error, 'load'))} error={history.error} onretry={() => history.retry()} />
		{:else if history.status !== 'ready'}
			<p class="text-slate-600" role="status">{m['admin.imports.loading']()}</p>
		{:else if history.empty}
			<p class="card p-6 text-slate-600">{m['admin.imports.empty']()}</p>
		{:else}
			<ul class="space-y-3">
				{#each history.items as job (job.id)}
					<li class="space-y-2 card p-4">
						<div class="flex flex-wrap items-start justify-between gap-2">
							<h3 class="min-w-0 font-medium break-all">{job.original_name}</h3>
							<span class={`rounded-full border px-2 py-0.5 text-xs ${statusClass(job.status)}`}>{statusLabel(job.status)}</span>
						</div>
						<dl class="grid gap-x-6 gap-y-1 text-sm text-slate-600 sm:grid-cols-2">
							<div class="flex gap-2"><dt>{m['admin.imports.job']()}</dt><dd class="font-mono">#{job.id}</dd></div>
							<div class="flex gap-2"><dt>{m['admin.imports.library']()}</dt><dd>{libraryLabel(job.library_id)}</dd></div>
							<div class="flex gap-2"><dt>{m['admin.imports.source']()}</dt><dd>{sourceLabel(job.source)}</dd></div>
							<div class="flex gap-2"><dt>{m['admin.imports.created']()}</dt><dd>{formatTimestamp(job.created_at)}</dd></div>
							{#if job.finished_at}
								<div class="flex gap-2"><dt>{m['admin.imports.finished']()}</dt><dd>{formatTimestamp(job.finished_at)}</dd></div>
							{/if}
						</dl>
						{#if job.status === 'imported' && job.book_id !== null}
							<a class={`text-sm ${linkClass}`} href={`/books/${job.book_id}`}>{m['admin.imports.view_book']({ id: job.book_id })}</a>
						{:else if job.status === 'duplicate' && job.duplicate_of_book_id !== null}
							<p class="text-sm">
								{m['admin.imports.duplicate_of']()}
								<a class={linkClass} href={`/books/${job.duplicate_of_book_id}`}>{m['admin.imports.view_book']({ id: job.duplicate_of_book_id })}</a>
							</p>
						{/if}
						{#if job.error}
							<p class="text-sm break-words text-red-800"><span class="font-medium">{m['admin.imports.error_label']()}</span> {job.error}</p>
						{/if}
					</li>
				{/each}
			</ul>
			<PagerFooter pager={history} loadMoreLabel={m['admin.imports.load_more']()} />
		{/if}
	</section>
</section>
