<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { ApiError } from '#lib/api/client.js';
	import * as m from '#lib/paraglide/messages.js';
	import { saveMyReview, type Review } from '../reviews-api.js';

	let { bookId, initial, onSaved, onCancel }: {
		bookId: number;
		initial: string;
		onSaved: (review: Review) => void;
		onCancel: () => void;
	} = $props();

	const fieldId = $props.id();
	let draft = $state(untrack(() => initial));
	let busy = $state(false);
	let error = $state('');
	let field: HTMLTextAreaElement;

	onMount(() => field.focus());

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		const targetBookId = bookId;
		busy = true;
		error = '';
		try {
			const review = await saveMyReview(targetBookId, draft);
			if (bookId === targetBookId) onSaved(review);
		} catch (cause) {
			console.error('Could not save the book review', cause);
			if (bookId !== targetBookId) return;
			error = cause instanceof RangeError || (cause instanceof ApiError && cause.status === 400)
				? m['bd7.review_invalid']()
				: m['bv6.review_error']();
		} finally {
			busy = false;
		}
		if (error) {
			await tick();
			field?.focus();
		}
	}
</script>

<form class="space-y-3" onsubmit={submit}>
	<label class="sr-only" for={fieldId}>{m['bv6.review_field']()}</label>
	<textarea
		bind:this={field}
		id={fieldId}
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
		<button class="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium disabled:opacity-60" type="button" disabled={busy} onclick={onCancel}>{m['bv6.cancel']()}</button>
	</div>
	{#if error}<p class="text-sm text-red-800" role="alert">{error}</p>{/if}
</form>
