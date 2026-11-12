<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { ApiError } from '#lib/api/client.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import { backupDownloadPath, createBackup, listBackups, restoreBackup, type Backup } from '#lib/admin/backup.js';
	import { adminErrorKey } from '#lib/admin/form.js';
	import { formatTimestamp } from '#lib/admin/jobs.js';
	import { dangerButton, inputClass, linkClass, panelClass, primaryButton, secondaryButton, warningBox } from '#lib/admin/ui.js';
	import { translate } from '#lib/paging/translate.js';

	let backups = $state<Backup[]>([]);
	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let loadError = $state<unknown>(null);
	let error = $state('');
	let notice = $state('');
	let busy = $state(false);
	let pending = $state(false);
	let file = $state<File | null>(null);
	const blocked = $derived(busy || pending || status !== 'ready');

	onMount(() => {
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	});

	async function load(signal?: AbortSignal) {
		status = 'loading';
		loadError = null;
		try {
			const result = await listBackups(signal);
			backups = result.backups;
			pending = result.restore_pending;
			status = 'ready';
		} catch (cause) {
			if (signal?.aborted) return;
			loadError = cause;
			status = 'error';
		}
	}

	function failure(cause: unknown): string {
		if (cause instanceof ApiError) {
			if (cause.status === 400 || cause.status === 422) return m['admin.backup.invalid']();
			if (cause.status === 409) return m['admin.backup.conflict']();
			if (cause.status === 413) return m['admin.backup.too_large']();
		}
		return translate(adminErrorKey(cause, 'load'));
	}

	async function create() {
		if (blocked) return;
		busy = true;
		error = '';
		notice = '';
		try {
			const backup = await createBackup();
			notice = m['admin.backup.created']({ name: backup.name });
			await load();
		} catch (cause) {
			error = failure(cause);
		} finally {
			busy = false;
		}
	}

	async function restore(source: string | File) {
		if (blocked || !window.confirm(m['admin.backup.confirm_restore']())) return;
		busy = true;
		error = '';
		notice = '';
		try {
			await restoreBackup(source);
			pending = true;
		} catch (cause) {
			error = failure(cause);
		} finally {
			busy = false;
		}
	}

	function upload(event: SubmitEvent) {
		event.preventDefault();
		if (blocked) return;
		if (!file || file.size === 0 || !file.name.endsWith('.tar.gz')) {
			error = m['admin.backup.file_required']();
			return;
		}
		void restore(file);
	}
</script>

<svelte:head>
	<title>{m['admin.tabs.backup']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-8" aria-labelledby="backup-heading">
	<header class="space-y-2">
		<h1 id="backup-heading" class="text-3xl font-semibold tracking-tight">{m['admin.tabs.backup']()}</h1>
		<p class="text-slate-600">{m['admin.backup.description']()}</p>
	</header>
	<p class={warningBox}>{m['admin.backup.warning']()}</p>
	{#if notice}<p class="text-sm text-green-700" role="status">{notice}</p>{/if}
	{#if error}<AdminAlert message={error} />{/if}
	{#if pending}<p class={warningBox} role="status">{m['admin.backup.staged']()}</p>{/if}
	{#if busy}<p class="text-slate-600" role="status">{m['admin.backup.working']()}</p>{/if}

	<section class={panelClass} aria-labelledby="saved-backups-heading" aria-busy={busy || status === 'loading'}>
		<div class="flex flex-wrap items-center justify-between gap-3">
			<h2 id="saved-backups-heading" class="text-xl font-semibold">{m['admin.backup.saved']()}</h2>
			<div class="flex gap-2">
				<button type="button" class={secondaryButton} disabled={busy || status === 'loading'} onclick={() => load()}>{m['admin.imports.refresh']()}</button>
				<button type="button" class={primaryButton} disabled={blocked} onclick={create}>{m['admin.backup.create']()}</button>
			</div>
		</div>
		{#if status === 'error'}
			<AdminAlert message={failure(loadError)} error={loadError} onretry={() => load()} />
		{:else if status === 'loading'}
			<p role="status" class="text-slate-600">{m['admin.backup.loading']()}</p>
		{:else if backups.length === 0}
			<p class="text-slate-600">{m['admin.backup.empty']()}</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-left text-sm">
					<thead class="border-b border-slate-200 text-slate-600"><tr>
						<th scope="col" class="py-2 pr-4">{m['admin.backup.filename']()}</th>
						<th scope="col" class="py-2 pr-4">{m['admin.users.created_label']()}</th>
						<th scope="col" class="py-2 pr-4">{m['admin.backup.size']()}</th>
						<th scope="col" class="py-2">{m['admin.users.actions']()}</th>
					</tr></thead>
					<tbody>
						{#each backups as backup (backup.name)}
							<tr class="border-b border-slate-100">
								<td class="py-2 pr-4 break-all font-mono">{backup.name}</td>
								<td class="py-2 pr-4">{formatTimestamp(backup.created_at)}</td>
								<td class="py-2 pr-4">{(backup.size_bytes / 1024 / 1024).toFixed(2)} MiB</td>
								<td class="py-2"><div class="flex flex-wrap items-center gap-3">
									<a class={linkClass} href={backupDownloadPath(backup.name)} download>{m['admin.backup.download']()}<span class="sr-only"> {backup.name}</span></a>
									<button type="button" class={dangerButton} disabled={blocked} onclick={() => restore(backup.name)}>{m['admin.backup.restore']()}<span class="sr-only"> {backup.name}</span></button>
								</div></td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class={panelClass} aria-labelledby="restore-upload-heading">
		<h2 id="restore-upload-heading" class="text-xl font-semibold">{m['admin.backup.upload_restore']()}</h2>
		<p class="text-sm text-slate-600">{m['admin.backup.restore_help']()}</p>
		<form class="flex flex-wrap items-end gap-3" onsubmit={upload}>
			<label class="min-w-0 flex-1 space-y-1">
				<span class="block text-sm font-medium">{m['admin.backup.file_label']()}</span>
				<input class={`${inputClass} w-full`} type="file" accept=".tar.gz" disabled={blocked}
					onchange={(event) => { file = event.currentTarget.files?.[0] ?? null; error = ''; }} />
			</label>
			<button class={dangerButton} type="submit" disabled={blocked}>{m['admin.backup.upload_restore']()}</button>
		</form>
	</section>
</section>
