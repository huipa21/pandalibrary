<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import AnnotationEntry from './AnnotationEntry.svelte';
	import { ApiError } from '#lib/api/client.js';
	import { listPersonalActivity, type PersonalActivity } from './activity.js';
	import type { AnnotationKindFilter } from './entry.js';

	let { kind = '' }: { kind?: AnnotationKindFilter } = $props();
	type Status = 'loading' | 'ready' | 'error';
	let items = $state<PersonalActivity[]>([]);
	let nextCursor = $state<string | null>(null);
	let status = $state<Status>('loading');
	let loadingMore = $state(false);
	let loadError = $state(false);
	let failedCursor = $state<string | null>(null);
	let unavailable = $state(false);
	let controller: AbortController | null = null;
	let version = 0;

	$effect(() => {
		const currentKind = kind;
		untrack(() => void load(null, currentKind));
	});
	onDestroy(() => {
		version += 1;
		controller?.abort();
	});

	async function load(cursor: string | null = null, currentKind = kind) {
		if (cursor && controller) return;
		const current = ++version;
		controller?.abort();
		const request = new AbortController();
		controller = request;
		loadError = false;
		unavailable = false;
		if (cursor) loadingMore = true;
		else {
			items = [];
			nextCursor = null;
			status = 'loading';
		}
		try {
			const page = await listPersonalActivity({ cursor, kind: currentKind, signal: request.signal });
			if (current !== version) return;
			items = cursor ? [...items, ...page.items] : page.items;
			nextCursor = page.next_cursor;
			status = 'ready';
		} catch (error) {
			if (current === version && !request.signal.aborted) {
				console.error('Could not load personal activity', error);
				loadError = true;
				unavailable = error instanceof ApiError && error.status === 404;
				failedCursor = cursor;
				if (items.length) status = 'ready';
				else status = 'error';
			}
		} finally {
			if (current === version) {
				controller = null;
				loadingMore = false;
			}
		}
	}

</script>

<section class="space-y-4" aria-labelledby="activity-heading" aria-busy={status === 'loading'}>
	<h2 id="activity-heading" class="flex items-baseline gap-2 text-xl font-semibold">
		{m['notes.activity.heading']()}
		{#if status === 'ready'}<span class="text-sm font-normal text-slate-600" role="status">{items.length}</span>{/if}
	</h2>
	{#if status === 'loading'}
		<p role="status" class="text-slate-600">{m['notes.activity.loading']()}</p>
	{:else if status === 'error'}
		<div class="flex flex-wrap items-center gap-3" role="alert">
			<p>{unavailable ? m['notes.activity.unavailable']() : m['notes.activity.error']()}</p>
			<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => void load(failedCursor)}>{m['notes.retry']()}</button>
		</div>
	{:else if items.length === 0}
		<p role="status" class="text-slate-600">{kind ? m['notes.filter.empty']() : m['notes.activity.empty']()}</p>
	{:else}
		<ol class="divide-y divide-slate-200" aria-label={m['notes.activity.list']()}>
			{#each items as item (`${item.kind}:${item.id}`)}
				<li>
					<AnnotationEntry {item} />
				</li>
			{/each}
		</ol>
		{#if loadError}
			<div class="flex flex-wrap items-center gap-3 text-sm" role="alert">
				<p>{unavailable ? m['notes.activity.unavailable']() : m['notes.activity.error']()}</p>
				<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => void load(failedCursor)}>{m['notes.retry']()}</button>
			</div>
		{/if}
		{#if nextCursor}
			<button
				type="button"
				class="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium disabled:opacity-60 focus-visible:outline-2"
				disabled={loadingMore || loadError}
				onclick={() => void load(nextCursor)}
			>
				{loadingMore ? m['notes.activity.loading_more']() : m['notes.activity.show_more']()}
			</button>
		{/if}
	{/if}
</section>