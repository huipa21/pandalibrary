<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';

	let {
		value = $bindable(''),
		input = $bindable<HTMLInputElement | null>(null),
		label,
		class: className = 'flex-1',
		buttonLabel = m['search.submit'](),
		disabled = false,
		onsearch,
		clear = false,
		...attributes
	}: Omit<HTMLInputAttributes, 'value' | 'type' | 'class'> & {
		value?: string;
		input?: HTMLInputElement | null;
		label: string;
		class?: string;
		buttonLabel?: string;
		disabled?: boolean;
		onsearch?: () => void;
		clear?: boolean;
	} = $props();
</script>

<div class="flex min-w-0 items-center gap-2 {className}">
	<input
		{...attributes}
		type="search"
		aria-label={label}
		class="site-search-input h-9 w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-normal focus-visible:outline-2 focus-visible:outline-offset-2"
		autocomplete="off"
		bind:value
		bind:this={input}
	/>
	<button
		type={onsearch ? 'button' : 'submit'}
		class="shell-search-submit inline-flex size-9 shrink-0 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60"
		aria-label={buttonLabel}
		title={buttonLabel}
		{disabled}
		onclick={onsearch}
	>
		<Icon name={clear ? 'x' : 'search'} class="size-4" />
	</button>
</div>

<style>
	input::-webkit-search-cancel-button {
		-webkit-appearance: none;
		appearance: none;
		display: none;
	}
</style>
