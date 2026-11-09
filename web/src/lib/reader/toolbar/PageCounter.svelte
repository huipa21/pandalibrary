<script lang="ts">
	import { untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { parsePage } from './helpers.js';
	import './toolbar.css';
	let { page, pageCount, disabled = false, onjump }: {
		page: number; pageCount: number; disabled?: boolean; onjump: (page: number) => void;
	} = $props();
	let focused = $state(false);
	let draft = $state(untrack(() => String(page)));
	$effect(() => { if (!focused) draft = String(page); });

	function commit() {
		const next = parsePage(draft, pageCount);
		draft = String(next ?? page);
		if (next !== null && next !== page) onjump(next);
	}
</script>

<span class="pv4-counter">
	<input
		class="pv4-page"
		style:width={`${Math.max(1, String(pageCount).length)}ch`}
		type="text"
		inputmode="numeric"
		pattern="[0-9]*"
		aria-label={m['pv4.page_of']({ page, pageCount })}
		disabled={disabled || pageCount < 1}
		bind:value={draft}
		onfocus={(event) => { focused = true; event.currentTarget.select(); }}
		onblur={() => { commit(); focused = false; }}
		onkeydown={(event) => {
			if (event.key === 'Enter') { event.preventDefault(); commit(); }
			else if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				draft = String(page);
				event.currentTarget.blur();
			}
		}}
	/>
	<span> / {pageCount}</span>
</span>
