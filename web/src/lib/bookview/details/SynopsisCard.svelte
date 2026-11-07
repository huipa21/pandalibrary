<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { Note } from '#lib/reader/types.js';
	import ExpandableText from '../ExpandableText.svelte';
	import ReviewEditor from './ReviewEditor.svelte';

	let { bookId, description, review, ready, failed, offline }: {
		bookId: number;
		description: string | null;
		review: Note | null;
		ready: boolean;
		failed: boolean;
		offline: boolean;
	} = $props();
</script>

<section class="min-w-0 space-y-5 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6" aria-labelledby="book-synopsis-heading">
	<div class="space-y-3">
		<h2 id="book-synopsis-heading" class="text-xs font-semibold tracking-wider text-slate-500 uppercase">{m['bv6.synopsis']()}</h2>
		{#if description}
			<div class="text-sm leading-6 text-slate-700"><ExpandableText text={description} lines={6} /></div>
		{:else}
			<p class="text-sm text-slate-500">{m['bv6.no_synopsis']()}</p>
		{/if}
	</div>
	<div class="border-t border-slate-200 pt-5">
		<ReviewEditor {bookId} {review} {ready} {failed} {offline} />
	</div>
</section>
