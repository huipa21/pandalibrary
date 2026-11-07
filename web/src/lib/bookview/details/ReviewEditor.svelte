<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { SyncError } from '#lib/reader/api.js';
	import type { Note } from '#lib/reader/types.js';
	import { saveReview } from './details-data.js';

	let { bookId, review, ready, failed, offline }: {
		bookId: number;
		review: Note | null;
		ready: boolean;
		failed: boolean;
		offline: boolean;
	} = $props();

	let editing = $state(false);
	let draft = $state('');
	let busy = $state(false);
	let error = $state('');

	$effect(() => {
		bookId;
		editing = false;
		draft = '';
		error = '';
	});

	function edit() {
		draft = review?.body_md ?? '';
		error = '';
		editing = true;
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy || !ready || offline) return;
		const targetBookId = bookId;
		busy = true;
		error = '';
		try {
			await saveReview(targetBookId, review, draft);
			if (bookId === targetBookId) editing = false;
		} catch (cause) {
			console.error('Could not save the book review', cause);
			if (bookId === targetBookId) {
				error = cause instanceof SyncError && cause.status === 'stale'
					? m['bv6.review_conflict']()
					: m['bv6.review_error']();
			}
		} finally {
			busy = false;
		}
	}
</script>

<section id="book-review" class="scroll-mt-24 space-y-3" aria-labelledby="book-review-heading">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<h3 id="book-review-heading" class="text-xs font-semibold tracking-wider text-slate-500 uppercase">{m['bv6.your_review']()}</h3>
		{#if ready && !offline && !editing}
			<button type="button" class="rounded text-sm font-semibold text-emerald-800 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-emerald-700" onclick={edit}>
				{review ? m['bv6.review_edit']() : m['bv6.review_write']()}
			</button>
		{/if}
	</div>
	{#if editing}
		<form class="space-y-3" onsubmit={submit}>
			<label class="sr-only" for={`review-${bookId}`}>{m['bv6.review_field']()}</label>
			<textarea
				id={`review-${bookId}`}
				class="block w-full rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-emerald-700"
				rows="5"
				maxlength="10000"
				bind:value={draft}
				disabled={busy}
			></textarea>
			<p class="text-xs text-slate-500">{m['bv6.review_count']({ count: String(draft.length) })}</p>
			<div class="flex flex-wrap gap-2">
				<button class="rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60" type="submit" disabled={busy}>
					{busy ? m['bv6.saving']() : m['bv6.save']()}
				</button>
				<button class="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium disabled:opacity-60" type="button" disabled={busy} onclick={() => (editing = false)}>{m['bv6.cancel']()}</button>
			</div>
		</form>
	{:else if !ready}
		<p class="text-sm text-slate-500">{failed ? m['bv6.state_error']() : m['bv6.state_loading']()}</p>
	{:else if review}
		<p class="whitespace-pre-wrap text-sm leading-6 text-slate-700 [overflow-wrap:anywhere]">{review.body_md}</p>
	{:else}
		<p class="text-sm text-slate-500">{m['bv6.review_empty']()}</p>
	{/if}
	{#if error}<p class="text-sm text-red-800" role="alert">{error}</p>{/if}
</section>
