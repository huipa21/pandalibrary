<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import AnnotationEntry from './AnnotationEntry.svelte';
	import { ApiError } from '#lib/api/client.js';
	import { listPersonalActivity, type PersonalActivity } from './activity.js';

	type Status = 'loading' | 'ready' | 'error';
	let items = $state<PersonalActivity[]>([]);
	let nextCursor = $state<string | null>(null);
	let status = $state<Status>('loading');
	let loadingMore = $state(false);
	let loadError = $state(false);
	let failedCursor = $state<string | null>(null);
	let unavailable = $state(false);
	let controller: AbortController | null = null;

	onMount(() => { void load(); });
	onDestroy(() => controller?.abort());

	async function load(cursor: string | null = null) {
		if (controller) return;
		controller = new AbortController();
		loadError = false;
		unavailable = false;
		if (cursor) loadingMore = true;
		else status = 'loading';
		try {
			const page = await listPersonalActivity({ cursor, signal: controller.signal });
			items = cursor ? [...items, ...page.items] : page.items;
			nextCursor = page.next_cursor;
			status = 'ready';
		} catch (error) {
			if (!controller.signal.aborted) {
				console.error('Could not load personal activity', error);
				loadError = true;
				unavailable = error instanceof ApiError && error.status === 404;
				failedCursor = cursor;
				if (items.length) status = 'ready';
				else status = 'error';
			}
		} finally {
			controller = null;
			loadingMore = false;
		}
	}

</script>

<section class="space-y-4" aria-labelledby="activity-heading" aria-busy={status === 'loading'}>
	<header class="flex flex-wrap items-baseline justify-between gap-2">
		<h2 id="activity-heading" class="text-xl font-semibold">{m['notes.activity.heading']()}</h2>
		{#if status === 'ready'}<span class="text-sm text-slate-600">{m['notes.activity.count']({ count: items.length })}</span>{/if}
	</header>
	{#if status === 'loading'}
		<p role="status" class="text-slate-600">{m['notes.activity.loading']()}</p>
	{:else if status === 'error'}
		<div class="flex flex-wrap items-center gap-3" role="alert">
			<p>{unavailable ? m['notes.activity.unavailable']() : m['notes.activity.error']()}</p>
			<button class="underline underline-offset-4 focus-visible:outline-2" onclick={() => void load(failedCursor)}>{m['notes.retry']()}</button>
		</div>
	{:else if items.length === 0}
		<p role="status" class="text-slate-600">{m['notes.activity.empty']()}</p>
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