<script lang="ts">
	import { tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { translate } from '#lib/paging/translate.js';
	import { focusableWithin, nextTrappedFocus } from '#lib/shell/focus.js';
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
	let dragDepth = $state(0);
	let confirming = $state(false);

	const counts = $derived(queue.counts);
	const finished = $derived(counts.uploaded + counts.duplicates + counts.failed);
	const hasResults = $derived(!queue.running && finished > 0);
	/** The Upload button stays focusable (aria-disabled) so focus is not lost when a run starts. */
	const canUpload = $derived(!queue.running && counts.pending > 0);
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
			dragDepth = 0;
			if (dialog.open) dialog.close();
			if (originalFocusElement?.isConnected) originalFocusElement.focus();
		};
	});

	$effect(() => {
		if (!queue.running) confirming = false;
	});

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
		const run = queue.retryFailed();
		await tick();
		uploadButton?.focus();
		await run;
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

	function ondragenter(event: DragEvent) {
		event.preventDefault();
		dragDepth += 1;
	}

	function ondragover(event: DragEvent) {
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
	}

	function ondragleave() {
		dragDepth = Math.max(0, dragDepth - 1);
	}

	function ondrop(event: DragEvent) {
		event.preventDefault();
		dragDepth = 0;
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
				return m['bh3.status_uploading']({ percent: uploadPercent(row) });
			case 'done':
				return row.item ? m['bh3.done_title']({ title: row.item.title }) : m['bh3.status_done']();
			case 'error':
				return translate(`bh3.error_${row.error ?? 'unknown'}`);
		}
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
			<div
				role="group"
				aria-labelledby="bh3-drop-label"
				data-testid="bh3-drop-zone"
				data-dragging={dragDepth > 0 ? 'true' : undefined}
				class={[
					'flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors',
					dragDepth > 0 ? 'border-emerald-500 bg-emerald-50' : 'border-slate-300 bg-slate-50'
				]}
				{ondragenter}
				{ondragover}
				{ondragleave}
				{ondrop}
			>
				<svg aria-hidden="true" viewBox="0 0 24 24" class="size-8 text-slate-400" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<path d="M12 16V4m0 0L7 9m5-5l5 5M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
				</svg>
				<p id="bh3-drop-label" class="text-sm font-medium">
					{dragDepth > 0 ? m['bh3.drop_active']() : m['bh3.drop_zone']()}
				</p>
				<p class="text-xs text-slate-600">{m['bh3.drop_hint']({ limit })}</p>
				<div class="flex flex-wrap justify-center gap-2">
					<button
						bind:this={selectButton}
						type="button"
						class="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
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
			</div>

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
				<ul class="max-h-80 divide-y divide-slate-200 overflow-y-auto rounded-md border border-slate-200" aria-label={m['bh3.list_label']()}>
					{#each queue.rows as row (row.id)}
						{@const percent = uploadPercent(row)}
						<li class="flex items-center gap-3 px-3 py-2" data-status={row.status}>
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium" title={row.file.name}>{row.file.name}</p>
								<p class="flex flex-wrap gap-x-2 text-xs text-slate-600">
									<span>{formatBytes(row.file.size, getLocale())}</span>
									<span
										class={row.status === 'error' ? 'text-red-700' : row.status === 'done' ? 'text-emerald-700' : ''}
										data-testid="bh3-row-status"
									>
										{#if row.status === 'error' && row.error === 'duplicate_book' && row.duplicateOf !== null && !queue.running}
											<a class="underline underline-offset-2" href={`/books/${row.duplicateOf}`} onclick={finishClose}>{statusText(row)}</a>
										{:else}
											{statusText(row)}
										{/if}
									</span>
								</p>
								{#if row.status === 'uploading'}
									<div
										class="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-200"
										role="progressbar"
										aria-label={m['bh3.progress_label']({ name: row.file.name })}
										aria-valuemin={0}
										aria-valuemax={100}
										aria-valuenow={percent}
									>
										<div class="h-full bg-emerald-600 transition-[width]" style:width={`${percent}%`}></div>
									</div>
								{/if}
							</div>
							<button
								type="button"
								class="grid size-7 shrink-0 place-items-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
								aria-label={m['bh3.remove']({ name: row.file.name })}
								disabled={row.status === 'uploading'}
								onclick={() => queue.remove(row.id)}
							>
								<svg aria-hidden="true" viewBox="0 0 20 20" class="size-4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15" /></svg>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<p class="sr-only" aria-live="polite">{announcement}</p>

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
				<div class="flex flex-wrap items-center gap-3">
					<div class="min-w-0 flex-1 text-sm text-slate-700">
						{#if queue.rows.length > 0}
							<p data-testid="bh3-summary">
								{queue.rows.length === 1 ? m['bh3.summary_one']({ size }) : m['bh3.summary_other']({ count: queue.rows.length, size })}
							</p>
						{/if}
						{#if hasResults}
							<p class="font-medium" data-testid="bh3-result">
								{m['bh3.result']({ uploaded: counts.uploaded, duplicates: counts.duplicates, failed: counts.failed })}
							</p>
						{/if}
					</div>
					{#if hasResults}
						<a
							class="text-sm font-medium text-emerald-800 underline underline-offset-4 hover:text-emerald-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
							href="/bookheap"
							onclick={finishClose}
						>{m['bh3.view_bookheap']()}</a>
					{/if}
					{#if !queue.running && counts.retryable > 0}
						<button
							type="button"
							class="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
							onclick={() => void retryFailed()}
						>{m['bh3.retry_failed']()}</button>
					{/if}
					<button
						type="button"
						class="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
						onclick={() => void requestClose()}
					>{m['bh3.close']()}</button>
					<button
						bind:this={uploadButton}
						type="button"
						class="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
						aria-disabled={!canUpload}
						onclick={() => {
							if (canUpload) void queue.start();
						}}
					>{queue.running ? m['bh3.uploading']() : m['bh3.upload']()}</button>
				</div>
			{/if}
		</div>
	</dialog>
{/if}

<style>
	dialog::backdrop {
		background: rgb(15 23 42 / 0.6);
	}
</style>
