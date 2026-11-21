<script lang="ts">
	import { showLoadingAfterDelay } from '#lib/ui/deferred.js';
	import { tick } from 'svelte';
	import Icon from '#lib/bookview/Icon.svelte';
	import UploadDropzone from '#lib/upload/UploadDropzone.svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { translate } from '#lib/paging/translate.js';
	import { focusableWithin, nextTrappedFocus } from '#lib/shell/focus.js';
	import type { Library } from '#lib/admin/types.js';
	import type { Shelf } from '#lib/shelves/types.js';
	import { inputClass } from '#lib/admin/ui.js';
	import { heapErrorKey } from './results.js';
	import { loadAssignTargets, shelfLabel } from './targets.js';
	import { rememberLastUploadLibraryId, resolveUploadLibraryId } from './upload-library.js';
	import {
		UPLOAD_ACCEPT,
		filesFromDataTransfer,
		formatBytes,
		uploadPercent,
		uploadQueue,
		type UploadQueue,
		type UploadRow
	} from './upload-queue.svelte.js';

	interface Props {
		open: boolean;
		onclose: () => void;
		/** Defaults to the shared queue so every host shows the same uploads. */
		queue?: UploadQueue;
	}

	let { open, onclose, queue = uploadQueue }: Props = $props();

	let dialogElement = $state<HTMLDialogElement | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);
	let selectButton = $state<HTMLButtonElement | null>(null);
	let keepButton = $state<HTMLButtonElement | null>(null);
	let uploadButton = $state<HTMLButtonElement | null>(null);
	let confirming = $state(false);
	let libraries = $state<Library[]>([]);
	let shelves = $state<Shelf[]>([]);
	let librariesError = $state('');
	let librariesLoading = $state(true);
	let targetsReady = $state(false);
	let libraryValidation = $state(false);
	let librarySelect = $state<HTMLSelectElement | null>(null);
	let librariesController: AbortController | null = null;

	const counts = $derived(queue.counts);
	const finished = $derived(counts.uploaded + counts.duplicates + counts.failed);
	const hasResults = $derived(!queue.running && finished > 0);
	/** The Upload button stays focusable (aria-disabled) so focus is not lost when a run starts. */
	const validLibrary = $derived(
		targetsReady && Number.isSafeInteger(queue.libraryId) && libraries.some((library) => library.id > 0 && library.id === queue.libraryId)
	);
	const canUpload = $derived(!queue.running && counts.pending > 0 && validLibrary);
	/** Keep the action visible while a run is active, and before the first upload. */
	const showUpload = $derived(counts.pending > 0 || counts.uploading > 0 || (!queue.running && finished === 0));
	const size = $derived(formatBytes(queue.totalBytes, getLocale()));
	const limit = $derived(formatBytes(queue.maxBytes, getLocale()));
	const announcement = $derived(
		queue.running
			? m['bh3.progress']({ finished, total: queue.rows.length })
			: hasResults
				? m['bh3.result']({ uploaded: counts.uploaded, duplicates: counts.duplicates, failed: counts.failed })
				: ''
	);

	$effect(() => {
		if (!open || !dialogElement) return;
		const dialog = dialogElement;
		const originalFocusElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialog.showModal();
		selectButton?.focus();
		return () => {
			confirming = false;
			if (dialog.open) dialog.close();
			if (originalFocusElement?.isConnected) originalFocusElement.focus();
		};
	});

	$effect(() => {
		if (!queue.running) confirming = false;
	});

	$effect(() => {
		if (!open) return;
		void loadLibraries();
		return () => librariesController?.abort();
	});

	async function loadLibraries() {
		librariesController?.abort();
		const controller = new AbortController();
		librariesController = controller;
		librariesLoading = true;
		targetsReady = false;
		librariesError = '';
		libraryValidation = false;
		libraries = [];
		shelves = [];
		try {
			const result = await loadAssignTargets(controller.signal);
			if (controller.signal.aborted) return;
			libraries = result.libraries;
			shelves = result.shelves;
			const previousLibraryId = queue.libraryId;
			const resolvedLibraryId = resolveUploadLibraryId(libraries, queue.libraryId);
			if (resolvedLibraryId !== previousLibraryId) {
				queue.libraryId = resolvedLibraryId;
				queue.resetForLibrary();
			}
			rememberLastUploadLibraryId(queue.libraryId);
			queue.shelfIds = queue.shelfIds.filter((id) => shelves.some((shelf) => shelf.id === id)).slice(0, 1);
			targetsReady = true;
		} catch (cause) {
			if (!controller.signal.aborted) {
				queue.libraryId = null;
				queue.shelfIds = [];
				librariesError = translate(heapErrorKey(cause, 'load_targets'));
			}
		} finally {
			if (!controller.signal.aborted) librariesLoading = false;
		}
	}

	function finishClose() {
		queue.dropDone();
		onclose();
	}

	async function requestClose() {
		if (!queue.running) {
			finishClose();
			return;
		}
		confirming = true;
		await tick();
		keepButton?.focus();
	}

	async function confirmStop() {
		await queue.abort();
		finishClose();
	}

	async function keepUploading() {
		confirming = false;
		await tick();
		selectButton?.focus();
	}

	/** The clicked control is disabled or removed afterwards, so focus moves to a stable one. */
	function clearAll() {
		queue.clear();
		selectButton?.focus();
	}

	async function retryFailed() {
		if (!validateTargets() || queue.running) return;
		const run = queue.retryFailed();
		await tick();
		uploadButton?.focus();
		await run;
	}

	function validateTargets() {
		if (!validLibrary) {
			libraryValidation = true;
			librarySelect?.focus();
			return false;
		}
		queue.shelfIds = queue.shelfIds.filter((id) => shelves.some((shelf) => shelf.id === id)).slice(0, 1);
		return true;
	}

	function startUpload() {
		if (queue.running || counts.pending === 0 || !validateTargets()) return;
		void queue.start();
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			if (confirming) void keepUploading();
			else void requestClose();
			return;
		}
		if (event.key === 'Tab') {
			const target = nextTrappedFocus(focusableWithin(dialogElement), document.activeElement, event.shiftKey);
			if (target) {
				event.preventDefault();
				target.focus();
			}
		}
	}

	function oncancel(event: Event) {
		event.preventDefault();
		void requestClose();
	}

	/** The browser can force-close a modal; keep the host state in sync. */
	function onNativeClose() {
		if (!open) return;
		if (queue.running) void queue.abort();
		finishClose();
	}

	function onpick() {
		if (!fileInput) return;
		queue.add(Array.from(fileInput.files ?? []));
		fileInput.value = '';
	}

	function ondrop(event: DragEvent) {
		event.preventDefault();
		const { files, ignored } = filesFromDataTransfer(event.dataTransfer);
		queue.add(files, ignored);
	}

	/** Stops files dropped outside the drop zone from navigating away. */
	function blockDrop(event: DragEvent) {
		event.preventDefault();
	}

	function statusText(row: UploadRow): string {
		switch (row.status) {
			case 'pending':
				return m['bh3.status_pending']();
			case 'uploading':
				if (row.item) return m['bh3.status_assigning']();
				return m['bh3.status_uploading']({ percent: uploadPercent(row) });
			case 'done':
				return '';
			case 'error':
				if (row.item) return m['bh3.assignment_failed']();
				return translate(`bh3.error_${row.error ?? 'unknown'}`);
		}
	}

	function visibilityLabel(row: UploadRow): string {
		return row.visibility === 'private' ? m['bh.visibility.private']() : m['bh.visibility.public']();
	}
</script>

{#if open}
	<dialog
		bind:this={dialogElement}
		class="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-2xl flex-col rounded-lg bg-white p-0 text-slate-950 shadow-xl open:flex"
		aria-labelledby="bh3-upload-title"
		aria-describedby="bh3-upload-description"
		{onkeydown}
		{oncancel}
		onclose={onNativeClose}
		ondragover={blockDrop}
		ondrop={blockDrop}
	>
		<div class="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
			<div>
				<h2 id="bh3-upload-title" class="text-lg font-semibold">{m['bh3.title']()}</h2>
				<p id="bh3-upload-description" class="mt-1 text-sm text-slate-600">{m['bh3.description']()}</p>
			</div>
			<button
				type="button"
				class="grid size-8 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
				aria-label={m['bh3.close']()}
				onclick={() => void requestClose()}
			>
				<svg aria-hidden="true" viewBox="0 0 20 20" class="size-5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15" /></svg>
			</button>
		</div>

		<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
			<div class="space-y-2">
				<div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
					<div class="flex min-w-0 items-center gap-2">
						<Icon name="library" class="size-5 shrink-0 text-slate-500" />
						<label for="bh3-library" class="sr-only">{m['bh3.library']()}</label>
						<select
							bind:this={librarySelect}
							id="bh3-library"
							class={`min-w-0 flex-1 ${inputClass}`}
							value={queue.libraryId === null ? '' : String(queue.libraryId)}
							required
							disabled={queue.running || !targetsReady}
							aria-busy={librariesLoading}
							aria-invalid={libraryValidation && !validLibrary ? 'true' : undefined}
							aria-describedby="bh3-library-help bh3-library-guidance"
							onchange={(event) => {
								const libraryId = event.currentTarget.value ? Number(event.currentTarget.value) : null;
								if (libraryId !== queue.libraryId) {
									queue.libraryId = libraryId;
									queue.resetForLibrary();
								}
								rememberLastUploadLibraryId(queue.libraryId);
								libraryValidation = false;
							}}
						>
							<option value="">{m['bh3.library_none']()}</option>
							{#each libraries as library (library.id)}
								<option value={String(library.id)}>{library.name}</option>
							{/each}
						</select>
					</div>
					<div class="flex min-w-0 items-center gap-2">
						<Icon name="folder" class="size-5 shrink-0 text-slate-500" />
						<label for="bh3-shelf" class="sr-only">{m['bh3.shelf']()}</label>
						<select
							id="bh3-shelf"
							class={`min-w-0 flex-1 ${inputClass}`}
							value={queue.shelfIds[0] === undefined ? '' : String(queue.shelfIds[0])}
							disabled={queue.running || !targetsReady}
							onchange={(event) => {
								queue.shelfIds = event.currentTarget.value ? [Number(event.currentTarget.value)] : [];
							}}
						>
							<option value="">{m['bh3.shelf_none']()}</option>
							{#each shelves as shelf (shelf.id)}
								<option value={String(shelf.id)}>{shelfLabel(shelf)}</option>
							{/each}
						</select>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={queue.visibility === 'public'}
						aria-label={m['bh.visibility.label']()}
						aria-describedby="bh-upload-visibility-help"
						title={queue.visibility === 'public' ? m['bh.visibility.public']() : m['bh.visibility.private']()}
						class="grid size-11 shrink-0 place-items-center rounded-md border border-slate-300 bg-white text-sm font-medium hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
						disabled={queue.running}
						onclick={() => (queue.visibility = queue.visibility === 'public' ? 'private' : 'public')}
					>
						<Icon name={queue.visibility === 'public' ? 'eye' : 'eye-off'} class="size-5 shrink-0" />
					</button>
				</div>
				<p id="bh3-library-help" class="sr-only">{m['bh3.library_help']()}</p>
				<p id="bh-upload-visibility-help" class="sr-only">{m['bh.visibility.help']()}</p>
				<div id="bh3-library-guidance">
					{#if librariesLoading}
						<p use:showLoadingAfterDelay class="text-sm text-slate-600" role="status">{m['bh4.assign.loading']()}</p>
					{:else if targetsReady && libraries.length === 0}
						<p class="text-sm text-slate-600">
							{m['bh4.assign.no_libraries']()}
							<a class="underline" href="/libraries?create=1">{m['bh4.assign.manage_libraries']()}</a>
						</p>
					{:else if targetsReady && !validLibrary}
						<p class="text-sm text-red-800">{m['bh4.assign.library_required']()}</p>
					{/if}
				</div>
				{#if targetsReady && shelves.length === 0}
					<p class="text-sm text-slate-600">{m['bh4.assign.no_shelves']()}</p>
				{/if}
				{#if librariesError}
					<div class="flex items-center gap-2 text-sm text-red-800" role="alert">
						<p>{librariesError}</p>
						<button type="button" class="underline" onclick={() => void loadLibraries()}>{m['admin.retry']()}</button>
					</div>
				{/if}
			</div>
			<UploadDropzone
				label={m['bh3.drop_zone']()}
				activeLabel={m['bh3.drop_active']()}
				hint={m['bh3.drop_hint']({ limit })}
				testId="bh3-drop-zone"
				disabled={!open}
				{ondrop}
			>
				<div class="flex flex-wrap justify-center gap-2">
					<button
						bind:this={selectButton}
						type="button"
						class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 app-focus-ring"
						onclick={() => fileInput?.click()}
					>{m['bh3.select']()}</button>
					<button
						type="button"
						class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
						disabled={queue.rows.length === 0 || queue.running}
						onclick={clearAll}
					>{m['bh3.clear']()}</button>
				</div>
				<input
					bind:this={fileInput}
					type="file"
					multiple
					accept={UPLOAD_ACCEPT}
					class="hidden"
					tabindex="-1"
					aria-hidden="true"
					data-testid="bh3-file-input"
					onchange={onpick}
				/>
			</UploadDropzone>

			{#if queue.rows.length > 0}
				<p
					class={[
						'rounded-md border px-3 py-2 text-sm font-medium',
						counts.failed > 0 ? 'border-amber-300 bg-amber-50 text-amber-900' : hasResults ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-slate-200 bg-slate-50 text-slate-700'
					]}
					data-testid="bh3-summary"
				>
					<span data-testid="bh3-result">{m['bh3.result']({ uploaded: counts.uploaded, duplicates: counts.duplicates, failed: counts.failed })}</span>
					<span aria-hidden="true"> · </span>
					<span>{m['bh3.space_used']({ size })}</span>
				</p>
			{/if}

			{#if queue.notice}
				<div class="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="status">
					<div class="min-w-0 flex-1 space-y-1 break-words">
						{#if queue.notice.unsupported.length > 0}
							<p>{m['bh3.notice_unsupported']({ names: queue.notice.unsupported.join(', ') })}</p>
						{/if}
						{#if queue.notice.tooLarge.length > 0}
							<p>{m['bh3.notice_too_large']({ limit, names: queue.notice.tooLarge.join(', ') })}</p>
						{/if}
						{#if queue.notice.ignored > 0}
							<p>{m['bh3.notice_ignored']()}</p>
						{/if}
					</div>
					<button
						type="button"
						class="grid size-6 shrink-0 place-items-center rounded text-amber-800 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
						aria-label={m['bh3.notice_dismiss']()}
						onclick={() => queue.dismissNotice()}
					>
						<svg aria-hidden="true" viewBox="0 0 20 20" class="size-4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15" /></svg>
					</button>
				</div>
			{/if}

			{#if queue.stopped}
				<p class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
					{queue.stopped === 'unauthorized' ? m['bh3.stopped_unauthorized']() : m['bh3.stopped_forbidden']()}
				</p>
			{/if}

			{#if queue.rows.length === 0}
				<p class="py-4 text-center text-sm text-slate-600">{m['bh3.empty']()}</p>
			{:else}
				<ul class="max-h-80 shrink-0 divide-y divide-slate-200 overflow-y-auto rounded-md border border-slate-200" aria-label={m['bh3.list_label']()}>
					{#each queue.rows as row (row.id)}
						{@const percent = uploadPercent(row)}
						<li class={['px-3 py-1.5', row.status === 'done' ? 'bg-emerald-50' : '']} data-status={row.status}>
							<div class="flex min-w-0 items-center gap-2">
								{#if row.status === 'done'}
									<svg data-testid="bh3-success-mark" aria-hidden="true" viewBox="0 0 24 24" class="size-4 shrink-0 rounded-full bg-emerald-700 p-0.5 text-white" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6" /></svg>
								{/if}
								<p class="min-w-0 flex-1 truncate text-sm font-medium leading-5" title={row.file.name}>{row.file.name}</p>
								<span class="shrink-0 text-xs tabular-nums text-slate-600">{formatBytes(row.file.size, getLocale())}</span>
								{#if row.visibility}
									<span class="shrink-0 text-slate-500" title={visibilityLabel(row)} data-testid="bh3-row-visibility">
										<Icon name={row.visibility === 'public' ? 'eye' : 'eye-off'} class="size-4" />
										<span class="sr-only">{visibilityLabel(row)}</span>
									</span>
								{/if}
								{#if row.status === 'pending' || row.status === 'uploading'}
									<span class={['shrink-0 text-xs', row.status === 'uploading' ? 'text-slate-600' : 'text-slate-500']} data-testid="bh3-row-status">
										{statusText(row)}
									</span>
								{:else if row.status === 'error'}
									{#if row.error === 'duplicate_book' && row.duplicateOf !== null && !queue.running}
										<a class="min-w-0 max-w-[55%] break-words text-right text-xs text-red-700 underline underline-offset-2" href={`/books/${row.duplicateOf}`} onclick={finishClose} data-testid="bh3-row-status">
											{statusText(row)}
										</a>
									{:else}
										<span class="min-w-0 max-w-[55%] break-words text-right text-xs text-red-700" data-testid="bh3-row-status">
											{statusText(row)}
										</span>
									{/if}
								{/if}
								{#if row.status === 'pending'}
									<button
										type="button"
										class="grid size-7 shrink-0 place-items-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
										aria-label={m['bh3.remove']({ name: row.file.name })}
										onclick={() => queue.remove(row.id)}
									>
										<Icon name="x" class="size-4" />
									</button>
								{/if}
							</div>
							{#if row.status === 'uploading'}
								<div
									class="mt-1 h-1 overflow-hidden rounded-full bg-slate-200"
									role="progressbar"
									aria-label={m['bh3.progress_label']({ name: row.file.name })}
									aria-valuemin={0}
									aria-valuemax={100}
									aria-valuenow={percent}
								>
									<div class="h-full bg-emerald-600 transition-[width]" style:width={`${percent}%`}></div>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<p class="sr-only" aria-live="polite">{announcement}</p>

		{#if confirming || showUpload || (!queue.running && counts.retryable > 0)}
			<div class="border-t border-slate-200 px-5 py-4">
				{#if confirming}
					<div class="space-y-3">
						<p class="text-sm" role="alert">{m['bh3.confirm_close']()}</p>
						<div class="flex flex-wrap justify-end gap-2">
							<button
								bind:this={keepButton}
								type="button"
								class="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
								onclick={() => void keepUploading()}
							>{m['bh3.confirm_continue']()}</button>
							<button
								type="button"
								class="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
								onclick={() => void confirmStop()}
							>{m['bh3.confirm_stop']()}</button>
						</div>
					</div>
				{:else}
					<div class="flex flex-wrap items-center justify-end gap-2">
						{#if !queue.running && counts.retryable > 0}
							<button
								type="button"
								class="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
								aria-disabled={!validLibrary}
								onclick={() => void retryFailed()}
							>{m['bh3.retry_failed']()}</button>
						{/if}
						{#if showUpload}
							<button
								bind:this={uploadButton}
								type="button"
								class="grid size-9 place-items-center rounded-md bg-emerald-700 text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
								aria-disabled={!canUpload}
								title={queue.running ? m['bh3.uploading']() : m['bh3.upload']()}
								onclick={startUpload}
							>
								<svg aria-hidden="true" viewBox="0 0 20 20" class="size-5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13V3m0 0L6 7m4-4l4 4M3 13v2a2 2 0 002 2h10a2 2 0 002-2v-2" /></svg>
								<span class="sr-only">{queue.running ? m['bh3.uploading']() : m['bh3.upload']()}</span>
							</button>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	</dialog>
{/if}

<style>
	dialog::backdrop {
		background: rgb(15 23 42 / 0.6);
	}
</style>
