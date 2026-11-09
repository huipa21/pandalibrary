<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { ApiError } from '#lib/api/client.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import { listMaintenanceJobs, runMaintenanceJob } from '#lib/admin/api.js';
	import { adminErrorKey } from '#lib/admin/form.js';
	import { formatTimestamp, isMaintenanceActive, scheduleParts } from '#lib/admin/jobs.js';
	import { BoundedPoller } from '#lib/admin/poller.js';
	import type { MaintenanceJob } from '#lib/admin/types.js';
	import { errorBox, panelClass, primaryButton, secondaryButton } from '#lib/admin/ui.js';
	import { translate } from '#lib/paging/translate.js';

	const POLL_INTERVAL_MS = 2000;
	const POLL_MAX_TICKS = 90;

	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let loadError = $state<unknown>(null);
	let refreshError = $state<unknown>(null);
	let refreshing = $state(false);
	let jobs = $state<MaintenanceJob[]>([]);
	let running = $state<Record<string, boolean>>({});
	let messages = $state<Record<string, { text: string; error: boolean }>>({});
	const controller = new AbortController();
	let inflight: Promise<boolean> | null = null;
	let destroyed = false;

	const poller = new BoundedPoller(
		async () => {
			try {
				return await refresh();
			} catch (cause) {
				return !(cause instanceof ApiError && (cause.status === 401 || cause.status === 403));
			}
		},
		{ intervalMs: POLL_INTERVAL_MS, maxTicks: POLL_MAX_TICKS }
	);

	onMount(() => void load());
	onDestroy(() => {
		destroyed = true;
		poller.stop();
		controller.abort();
	});

	function startPolling() {
		if (!destroyed) poller.start();
	}

	async function load() {
		status = 'loading';
		loadError = null;
		try {
			jobs = await listMaintenanceJobs(controller.signal);
			status = 'ready';
			if (jobs.some(isMaintenanceActive)) startPolling();
		} catch (cause) {
			if (destroyed) return;
			loadError = cause;
			status = 'error';
		}
	}

	/** Re-reads job status without blanking the list; resolves to whether any job is still active. */
	function refresh(): Promise<boolean> {
		if (inflight) return inflight;
		refreshing = true;
		const pending = (async () => {
			try {
				const fresh = await listMaintenanceJobs(controller.signal);
				if (destroyed) return false;
				jobs = fresh;
				refreshError = null;
				return fresh.some(isMaintenanceActive);
			} catch (cause) {
				if (!destroyed) refreshError = cause;
				throw cause;
			} finally {
				refreshing = false;
				inflight = null;
			}
		})();
		inflight = pending;
		return pending;
	}

	async function manualRefresh() {
		try {
			if (await refresh()) startPolling();
		} catch {
			// Shown from refreshError.
		}
	}

	async function run(job: MaintenanceJob) {
		if (running[job.name] || isMaintenanceActive(job)) return;
		const name = jobName(job.name);
		if (!window.confirm(m['admin.maintenance.run_confirm']({ name }))) return;
		running[job.name] = true;
		delete messages[job.name];
		try {
			const run = await runMaintenanceJob(job.name);
			jobs = jobs.map((item) => (item.name === job.name ? { ...item, status: 'accepted', last_run: run } : item));
			messages[job.name] = { text: m['admin.maintenance.accepted']({ name }), error: false };
			startPolling();
		} catch (cause) {
			messages[job.name] = { text: translate(adminErrorKey(cause, 'run_job')), error: true };
			if (cause instanceof ApiError && cause.status === 409) {
				jobs = jobs.map((item) => (item.name === job.name ? { ...item, status: 'running' } : item));
				startPolling();
			}
		} finally {
			running[job.name] = false;
		}
	}

	function jobName(name: string): string {
		switch (name) {
			case 'annotation-assets-gc':
				return m['pv7.maintenance.name']();
			case 'cleanup-expired':
				return m['admin.maintenance.job.cleanup_expired']();
			case 'backup':
				return m['admin.maintenance.job.backup']();
			case 'orphan-sweep':
				return m['admin.maintenance.job.orphan_sweep']();
			case 'optimize':
				return m['admin.maintenance.job.optimize']();
			case 'fts-check':
				return m['admin.maintenance.job.fts_check']();
			case 'wal-checkpoint':
				return m['admin.maintenance.job.wal_checkpoint']();
			default:
				return name;
		}
	}

	function jobDescription(name: string): string {
		switch (name) {
			case 'annotation-assets-gc':
				return m['pv7.maintenance.description']();
			case 'cleanup-expired':
				return m['admin.maintenance.describe.cleanup_expired']();
			case 'backup':
				return m['admin.maintenance.describe.backup']();
			case 'orphan-sweep':
				return m['admin.maintenance.describe.orphan_sweep']();
			case 'optimize':
				return m['admin.maintenance.describe.optimize']();
			case 'fts-check':
				return m['admin.maintenance.describe.fts_check']();
			case 'wal-checkpoint':
				return m['admin.maintenance.describe.wal_checkpoint']();
			default:
				return '';
		}
	}

	function scheduleLabel(schedule: string): string {
		const parts = scheduleParts(schedule);
		switch (parts.unit) {
			case 'hours':
				return m['admin.maintenance.every_hours']({ count: parts.count });
			case 'minutes':
				return m['admin.maintenance.every_minutes']({ count: parts.count });
			case 'seconds':
				return m['admin.maintenance.every_seconds']({ count: parts.count });
			default:
				return parts.text;
		}
	}

	function statusLabel(value: string): string {
		switch (value) {
			case 'idle':
				return m['admin.maintenance.status.idle']();
			case 'accepted':
				return m['admin.maintenance.status.accepted']();
			case 'running':
				return m['admin.maintenance.status.running']();
			case 'completed':
				return m['admin.maintenance.status.completed']();
			case 'error':
				return m['admin.maintenance.status.error']();
			default:
				return value;
		}
	}

	function statusClass(value: string): string {
		if (value === 'completed') return 'border-green-300 bg-green-50 text-green-800';
		if (value === 'error') return 'border-red-300 bg-red-50 text-red-800';
		if (value === 'accepted' || value === 'running') return 'border-sky-300 bg-sky-50 text-sky-800';
		return 'border-slate-300 bg-slate-50 text-slate-700';
	}
</script>

<svelte:head>
	<title>{m['admin.maintenance.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-8" aria-labelledby="maintenance-heading">
	<header class="space-y-2">
		<h1 id="maintenance-heading" class="text-3xl font-semibold tracking-tight">{m['admin.maintenance.title']()}</h1>
		<p class="text-slate-600">{m['admin.maintenance.description']()}</p>
		<p class="text-sm text-slate-500">{m['admin.maintenance.restart_note']()}</p>
	</header>

	{#if status === 'error'}
		<AdminAlert message={translate(adminErrorKey(loadError, 'load'))} error={loadError} onretry={load} />
	{:else if status === 'loading'}
		<p class="text-slate-600" role="status">{m['admin.maintenance.loading']()}</p>
	{:else}
		<div class="flex flex-wrap items-center justify-between gap-3">
			{#if jobs.some(isMaintenanceActive)}
				<p class="text-sm text-slate-600" role="status">{m['admin.maintenance.auto_refresh']()}</p>
			{:else}
				<span></span>
			{/if}
			<button type="button" class={secondaryButton} disabled={refreshing} onclick={manualRefresh}>
				{refreshing ? m['admin.maintenance.refreshing']() : m['admin.maintenance.refresh']()}
			</button>
		</div>
		{#if refreshError}
			<AdminAlert message={translate(adminErrorKey(refreshError, 'load'))} error={refreshError} onretry={manualRefresh} />
		{/if}
		{#if jobs.length === 0}
			<p class="card p-6 text-slate-600">{m['admin.maintenance.empty']()}</p>
		{:else}
			<ul class="grid gap-4 md:grid-cols-2">
				{#each jobs as job (job.name)}
					{@const active = isMaintenanceActive(job)}
					<li class={panelClass} aria-labelledby={`job-${job.name}`}>
						<div class="flex flex-wrap items-start justify-between gap-2">
							<div class="space-y-1">
								<h2 id={`job-${job.name}`} class="text-lg font-semibold">{jobName(job.name)}</h2>
								<p class="font-mono text-xs text-slate-500">{job.name}</p>
							</div>
							<span class={`rounded-full border px-2 py-0.5 text-xs ${statusClass(job.status)}`}>{statusLabel(job.status)}</span>
						</div>
						{#if jobDescription(job.name)}<p class="text-sm text-slate-600">{jobDescription(job.name)}</p>{/if}
						<dl class="grid gap-1 text-sm text-slate-600">
							<div class="flex gap-2"><dt>{m['admin.maintenance.schedule']()}</dt><dd>{scheduleLabel(job.schedule)}</dd></div>
							<div class="flex gap-2">
								<dt>{m['admin.maintenance.last_run']()}</dt>
								<dd>
									{#if job.last_run}
										{formatTimestamp(job.last_run.completed_at ?? job.last_run.started_at ?? job.last_run.accepted_at)}
									{:else}
										{m['admin.maintenance.never']()}
									{/if}
								</dd>
							</div>
							{#if job.last_run}
								<div class="flex gap-2"><dt>{m['admin.maintenance.last_status']()}</dt><dd>{statusLabel(job.last_run.status)}</dd></div>
							{/if}
						</dl>
						{#if messages[job.name]}
							<p class={messages[job.name].error ? errorBox : 'text-sm text-green-700'} role={messages[job.name].error ? 'alert' : 'status'}>
								{messages[job.name].text}
							</p>
						{/if}
						<div>
							<button
								type="button"
								class={primaryButton}
								disabled={active || running[job.name]}
								aria-label={m['admin.maintenance.run_label']({ name: jobName(job.name) })}
								onclick={() => run(job)}
							>
								{running[job.name] ? m['admin.maintenance.starting']() : active ? m['admin.maintenance.in_progress']() : m['admin.maintenance.run']()}
							</button>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</section>
