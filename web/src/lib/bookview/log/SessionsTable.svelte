<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, tick, untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import Icon from '../Icon.svelte';
	import { notifyBookStateChanged } from '../events.js';
	import { formatDate, formatDuration, formatPercent } from '../format.js';
	import { deleteBookSession, listBookSessions, type BookSession, type SessionRange } from '../log-api.js';
	import { attemptDividers, changeTone, groupSessionsByDay, sessionsToCsv } from './log-model.js';

	interface Props {
		bookId: number;
		title: string;
		timezone: string;
		refreshVersion: number;
	}

	let { bookId, title, timezone, refreshVersion }: Props = $props();
	const pager = new CursorPager<BookSession>();
	const ranges: readonly { value: SessionRange; label: () => string }[] = [
		{ value: 'all', label: () => m['bv8.range_all']() },
		{ value: '30d', label: () => m['bv8.range_30d']() },
		{ value: '90d', label: () => m['bv8.range_90d']() },
		{ value: 'year', label: () => m['bv8.range_year']() }
	];
	const locale = $derived(getLocale());
	const rawRange = $derived(page.url.searchParams.get('range'));
	const range = $derived(rangeFromUrl(rawRange));
	const rows = $derived(attemptDividers(pager.items));
	const dayLabels = $derived(new Map(groupSessionsByDay(pager.items, timezone, locale)
		.map((group) => [group.sessions[0].id, group.label])));
	const timeFormatter = $derived(new Intl.DateTimeFormat(locale, { timeZone: timezone, timeStyle: 'short' }));
	const dateTimeFormatter = $derived(new Intl.DateTimeFormat(locale, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }));
	const signedPercent = $derived(new Intl.NumberFormat(locale, { style: 'percent', signDisplay: 'always', maximumFractionDigits: 1 }));
	let total = $state(0);
	let deletePending = $state<string | null>(null);
	let deleteError = $state('');
	let rangeError = $state('');
	let exporting = $state(false);
	let exportNotice = $state('');
	let exportError = $state('');
	let heading = $state<HTMLHeadingElement | null>(null);
	let exportController: AbortController | null = null;
	let queryVersion = 0;
	const exportLimit = 10_000;

	function rangeFromUrl(value: string | null): SessionRange {
		return value === '30d' || value === '90d' || value === 'year' ? value : 'all';
	}

	$effect(() => {
		const value = rawRange;
		if (value === null || ranges.some((option) => option.value === value)) return;
		const url = new URL(page.url.href);
		url.searchParams.set('range', 'all');
		untrack(() => void goto(url, { replace: true, reset: false }).catch((cause: unknown) => {
			console.error('Could not normalize the reading session range', cause);
			rangeError = m['bv8.sessions_error']();
		}));
	});

	$effect(() => {
		const targetBookId = bookId;
		const selectedRange = range;
		const selectedTimezone = timezone;
		refreshVersion;
		untrack(() => {
			const version = ++queryVersion;
			total = 0;
			deleteError = '';
			void pager.reset(async (cursor, signal) => {
				const result = await listBookSessions(targetBookId, {
					range: selectedRange, timezone: selectedTimezone, cursor, limit: 25, signal
				});
				if (!signal.aborted && version === queryVersion) total = result.total;
				return result;
			});
		});
		return () => {
			queryVersion += 1;
			if (exportController) {
				exportController.abort();
				exportController = null;
				exporting = false;
				exportNotice = m['bv8.export_cancelled']();
			}
		};
	});

	onDestroy(() => {
		exportController?.abort();
		pager.dispose();
	});

	async function selectRange(next: SessionRange) {
		if (next === range) return;
		const url = new URL(page.url.href);
		url.searchParams.set('range', next);
		rangeError = '';
		try {
			await goto(url, { replace: true, reset: false });
		} catch (cause) {
			console.error('Could not change the reading session range', cause);
			rangeError = m['bv8.sessions_error']();
		}
	}

	function formatChange(change: number | null): string {
		if (change === null) return m['bv8.no_data']();
		return change === 0 ? formatPercent(0, locale) : signedPercent.format(change);
	}

	function timestamp(session: BookSession): string {
		return dateTimeFormatter.format(new Date(session.started_at));
	}

	async function remove(session: BookSession) {
		if (deletePending !== null) return;
		const when = timestamp(session);
		if (!window.confirm(m['bv8.delete_confirm']({ date: when }))) return;
		const index = pager.items.findIndex((item) => item.id === session.id);
		if (index < 0) return;
		const version = queryVersion;
		const targetBookId = bookId;
		deletePending = session.id;
		deleteError = '';
		pager.items = pager.items.filter((item) => item.id !== session.id);
		total = Math.max(0, total - 1);
		await tick();
		heading?.focus();
		try {
			await deleteBookSession(targetBookId, session.id);
			notifyBookStateChanged(targetBookId);
		} catch (cause) {
			console.error('Could not delete a reading session', cause);
			if (version === queryVersion) {
				const restored = [...pager.items];
				restored.splice(Math.min(index, restored.length), 0, session);
				pager.items = restored;
				total += 1;
				deleteError = m['bv8.delete_failed']();
			} else {
				deleteError = m['bv8.delete_failed_other_range']();
			}
		} finally {
			deletePending = null;
		}
	}

	function filename(bookTitle: string): string {
		const safe = Array.from(bookTitle.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim())
			.slice(0, 120).join('').replace(/[. ]+$/, '');
		return `${safe || 'book'} reading log.csv`;
	}

	async function exportSessions() {
		if (exporting) return;
		const controller = new AbortController();
		exportController = controller;
		const targetBookId = bookId;
		const selectedRange = range;
		const selectedTimezone = timezone;
		const bookTitle = title;
		exporting = true;
		exportError = '';
		exportNotice = '';
		try {
			const sessions: BookSession[] = [];
			const seen = new Set<string>();
			let cursor: string | null = null;
			let truncated = false;
			do {
				const result = await listBookSessions(targetBookId, {
					range: selectedRange, timezone: selectedTimezone, cursor,
					limit: Math.min(100, exportLimit - sessions.length), signal: controller.signal
				});
				if (controller.signal.aborted) return;
				sessions.push(...result.items);
				cursor = result.next_cursor;
				if (cursor && result.items.length === 0) throw new Error('The session export page was empty before the end.');
				if (cursor && seen.has(cursor)) throw new Error('The session export cursor repeated.');
				if (cursor) seen.add(cursor);
				truncated = sessions.length > exportLimit || (sessions.length === exportLimit && cursor !== null);
			} while (cursor && sessions.length < exportLimit);
			const blob = new Blob([sessionsToCsv(sessions.slice(0, exportLimit))], { type: 'text/csv;charset=utf-8' });
			const objectUrl = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = objectUrl;
			link.download = filename(bookTitle);
			document.body.append(link);
			try {
				link.click();
			} finally {
				link.remove();
				setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
			}
			if (truncated) exportNotice = m['bv8.export_limited']();
		} catch (cause) {
			if (controller.signal.aborted) return;
			console.error('Could not export reading sessions', cause);
			exportError = m['bv8.export_failed']();
		} finally {
			if (exportController === controller) {
				exportController = null;
				exporting = false;
			}
		}
	}
</script>

<section class="min-w-0 overflow-hidden card" aria-labelledby="bv8-sessions-heading">
	<div class="space-y-4 p-5">
		<div class="flex flex-wrap items-baseline justify-between gap-2">
			<h2 id="bv8-sessions-heading" bind:this={heading} tabindex="-1" class="text-xs font-semibold uppercase tracking-wider text-slate-500 focus:outline-none">{m['bv8.sessions']()}</h2>
			<p class="text-xs text-slate-500">{m['bv8.showing']({ shown: pager.items.length, total })}</p>
		</div>
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 text-xs" role="group" aria-label={m['bv8.range']()}>
				{#each ranges as option (option.value)}
					<button type="button" aria-pressed={range === option.value}
						class={`rounded-md px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-emerald-700 ${range === option.value ? 'bg-white font-semibold text-emerald-800 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
						onclick={() => void selectRange(option.value)}>{option.label()}</button>
				{/each}
			</div>
			<button type="button" class="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-60"
				disabled={exporting || pager.status !== 'ready'} onclick={exportSessions}>
				<Icon name="download" class="size-4" /> {exporting ? m['bv8.exporting']() : m['bv8.export']()}
			</button>
		</div>
		{#if rangeError}<p class="text-sm text-red-800" role="alert">{rangeError}</p>{/if}
		{#if deleteError}<p class="text-sm text-red-800" role="alert">{deleteError}</p>{/if}
		{#if exportError}<p class="text-sm text-red-800" role="alert">{exportError}</p>{/if}
		{#if exportNotice}<p class="text-sm text-slate-600" role="status">{exportNotice}</p>{/if}
	</div>
	{#if pager.status === 'idle' || pager.status === 'loading'}
		<p class="px-5 pb-5 text-sm text-slate-500" role="status">{m['bv8.sessions_loading']()}</p>
	{:else if pager.status === 'error'}
		<div class="flex flex-wrap items-center gap-3 px-5 pb-5 text-sm text-red-800" role="alert">
			<p>{m['bv8.sessions_error']()}</p>
			<button type="button" class="underline underline-offset-4 focus-visible:outline-2" onclick={() => pager.retry()}>{m['bv8.retry']()}</button>
		</div>
	{:else if pager.items.length === 0}
		<p class="px-5 pb-5 text-sm text-slate-500">{m['bv8.sessions_empty']()}</p>
	{:else}
		<div class="max-h-[36rem] min-w-0 overflow-auto border-y border-slate-100">
			<table class="w-full min-w-max text-left text-xs">
				<thead class="sticky top-0 z-10 bg-slate-50 text-slate-500">
					<tr>
						<th scope="col" class="px-4 py-3 font-medium">{m['bv8.day']()}</th>
						<th scope="col" class="px-3 py-3 font-medium">{m['bv8.time']()}</th>
						<th scope="col" class="px-3 py-3 font-medium">{m['bv8.length']()}</th>
						<th scope="col" class="px-3 py-3 font-medium">{m['bv8.change']()}</th>
						<th scope="col" class="px-3 py-3 font-medium">{m['bv8.position']()}</th>
						<th scope="col" class="px-3 py-3 font-medium">{m['bv8.reached']()}</th>
						<th scope="col" class="px-3 py-3 font-medium">{m['bv8.source']()}</th>
						<th scope="col" class="px-3 py-3 font-medium"><span class="sr-only">{m['bv8.actions']()}</span></th>
					</tr>
				</thead>
				<tbody>
					{#each rows as row (row.kind === 'session' ? row.session.id : `attempt-${row.attempt}-${row.startedAt}`)}
						{#if row.kind === 'attempt'}
							<tr class="bg-emerald-50 text-emerald-800">
								<td colspan="8" class="px-4 py-2 font-medium">{m['bv8.attempt_began']({ number: row.attempt, date: formatDate(row.startedAt, locale) })}</td>
							</tr>
						{:else}
							{@const session = row.session}
							{@const tone = changeTone(session.change)}
							<tr class="border-t border-slate-100 text-slate-700">
								<td class="whitespace-nowrap px-4 py-3 font-medium">{dayLabels.get(session.id) ?? ''}</td>
								<td class="whitespace-nowrap px-3 py-3">{timeFormatter.format(new Date(session.started_at))}</td>
								<td class="whitespace-nowrap px-3 py-3">{formatDuration(session.active_seconds)}</td>
								<td class={`whitespace-nowrap px-3 py-3 font-medium ${tone === 'positive' ? 'text-emerald-700' : tone === 'negative' ? 'text-amber-700' : 'text-slate-500'}`}>{formatChange(session.change)}</td>
								<td class="px-3 py-3">
									{#if session.start_percentage !== null && session.end_percentage !== null}
										<div class="relative h-2 w-[100px] rounded-full bg-slate-100" role="img"
											aria-label={m['bv8.position_range']({ start: formatPercent(session.start_percentage, locale), end: formatPercent(session.end_percentage, locale) })}>
											<span class={`absolute h-full rounded-full ${tone === 'negative' ? 'bg-amber-500' : 'bg-emerald-500'}`}
												style:left={`${Math.min(session.start_percentage, session.end_percentage) * 100}%`}
												style:width={`${Math.abs(session.end_percentage - session.start_percentage) * 100}%`}></span>
										</div>
									{:else}
										<span class="text-slate-400">{m['bv8.no_data']()}</span>
									{/if}
								</td>
								<td class="whitespace-nowrap px-3 py-3">{session.end_percentage === null ? m['bv8.no_data']() : formatPercent(session.end_percentage, locale)}</td>
								<td class="px-3 py-3"><span title={session.device} class="rounded bg-slate-100 px-2 py-1 font-semibold text-slate-600">{session.source.toUpperCase()}</span></td>
								<td class="px-3 py-3">
									<button type="button" class="rounded p-1 text-slate-500 hover:bg-red-50 hover:text-red-700 focus-visible:outline-2 focus-visible:outline-red-700 disabled:opacity-50"
										aria-label={m['bv8.delete_session']({ date: timestamp(session) })} disabled={deletePending !== null} onclick={() => void remove(session)}>
										<Icon name="trash" class="size-4" />
									</button>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
		{#if pager.moreError}
			<p class="px-5 pt-4 text-sm text-red-800" role="alert">{m['bv8.load_more_failed']()}</p>
		{/if}
		{#if pager.hasMore}
			<div class="p-5">
				<button type="button" class="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-60"
					disabled={pager.loadingMore || deletePending !== null} onclick={() => pager.loadMore()}>
					{pager.loadingMore ? m['bv8.loading_more']() : pager.moreError ? m['bv8.retry']() : m['bv8.load_more']()}
				</button>
			</div>
		{/if}
	{/if}
</section>
