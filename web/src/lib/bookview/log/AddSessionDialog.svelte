<script lang="ts">
	import HeapDialog from '#lib/bookheap/HeapDialog.svelte';
	import { SyncError } from '#lib/reader/api.js';
	import { localDateString } from '#lib/stats/api.js';
	import * as m from '#lib/paraglide/messages.js';
	import { notifyBookStateChanged } from '../events.js';
	import { addManualSession } from '../log-api.js';

	interface Props {
		open: boolean;
		bookId: number;
		onclose: () => void;
	}

	let { open, bookId, onclose }: Props = $props();
	let date = $state('');
	let time = $state('');
	let duration = $state<number | undefined>(30);
	let startPercent = $state<number | undefined>(undefined);
	let endPercent = $state<number | undefined>(undefined);
	let error = $state('');
	let busy = $state(false);

	function localTime(value: Date): string {
		return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
	}

	$effect(() => {
		if (!open) return;
		const now = new Date();
		const start = new Date(now.getTime() - 30 * 60_000);
		const today = localDateString(now);
		const initialTime = localDateString(start) === today ? localTime(start) : '00:00';
		date = today;
		time = initialTime;
		duration = Math.max(1, Math.min(30, Math.floor((now.getTime() - new Date(`${today}T${initialTime}:00`).getTime()) / 60_000)));
		startPercent = undefined;
		endPercent = undefined;
		error = '';
		busy = false;
	});

	function parseLocalStart(): Date | null {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
		const value = new Date(`${date}T${time}:00`);
		if (!Number.isFinite(value.getTime()) || value.getTime() < 0 ||
			localDateString(value) !== date || localTime(value) !== time) return null;
		return value;
	}

	function validPercent(value: number | undefined): boolean {
		return value === undefined || (Number.isFinite(value) && value >= 0 && value <= 100);
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		error = '';
		const start = parseLocalStart();
		if (!start) {
			error = m['bv8.invalid_date']();
			return;
		}
		if (duration === undefined || !Number.isInteger(duration) || duration < 1 || duration > 1440) {
			error = m['bv8.invalid_duration']();
			return;
		}
		if (!validPercent(startPercent) || !validPercent(endPercent)) {
			error = m['bv8.invalid_percent']();
			return;
		}
		const end = new Date(start.getTime() + duration * 60_000);
		if (end.getTime() > Date.now()) {
			error = m['bv8.future_session']();
			return;
		}
		const targetBookId = bookId;
		busy = true;
		try {
			await addManualSession(targetBookId, {
				startedAt: start, endedAt: end, activeSeconds: duration * 60,
				startPercentage: startPercent === undefined ? null : startPercent / 100,
				endPercentage: endPercent === undefined ? null : endPercent / 100
			});
			notifyBookStateChanged(targetBookId);
			onclose();
		} catch (cause) {
			console.error('Could not add a reading session', cause);
			error = cause instanceof SyncError && cause.reason
				? m['bv8.sync_failed']({ reason: cause.reason })
				: m['bv8.save_failed']();
		} finally {
			busy = false;
		}
	}

	const inputClass = 'w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-emerald-700';
</script>

<HeapDialog {open} id="bv8-add-session" title={m['bv8.add_session']()} {onclose} {busy} initialFocus="#bv8-session-date">
	<p class="mt-2 text-sm text-slate-600">{m['bv8.add_session_description']()}</p>
	<form class="mt-5 space-y-4" onsubmit={save} novalidate>
		<div class="grid gap-4 sm:grid-cols-2">
			<label class="grid gap-1 text-sm font-medium" for="bv8-session-date">
				{m['bv8.date']()}
				<input id="bv8-session-date" class={inputClass} type="date" bind:value={date} required />
			</label>
			<label class="grid gap-1 text-sm font-medium" for="bv8-session-time">
				{m['bv8.start_time']()}
				<input id="bv8-session-time" class={inputClass} type="time" bind:value={time} required />
			</label>
		</div>
		<label class="grid gap-1 text-sm font-medium" for="bv8-session-duration">
			{m['bv8.duration']()}
			<input id="bv8-session-duration" class={inputClass} type="number" min="1" max="1440" step="1" bind:value={duration} required />
		</label>
		<div class="grid gap-4 sm:grid-cols-2">
			<label class="grid gap-1 text-sm font-medium" for="bv8-session-start">
				{m['bv8.start_percent']()}
				<input id="bv8-session-start" class={inputClass} type="number" min="0" max="100" step="any" bind:value={startPercent} />
			</label>
			<label class="grid gap-1 text-sm font-medium" for="bv8-session-end">
				{m['bv8.end_percent']()}
				<input id="bv8-session-end" class={inputClass} type="number" min="0" max="100" step="any" bind:value={endPercent} />
			</label>
		</div>
		{#if error}<p class="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p>{/if}
		<div class="flex flex-wrap justify-end gap-3 pt-2">
			<button type="button" class="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-60" disabled={busy} onclick={onclose}>{m['bv8.cancel']()}</button>
			<button type="submit" class="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:opacity-60" disabled={busy}>
				{busy ? m['bv8.saving']() : m['bv8.save']()}
			</button>
		</div>
	</form>
</HeapDialog>
