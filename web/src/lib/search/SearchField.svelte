<script lang="ts">
	import { tick } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import { controlIconClass, filterControlClass, primaryIconControlClass } from '#lib/catalog/filter-styles.js';

	let {
		value = $bindable(''),
		input = $bindable<HTMLInputElement | null>(null),
		label,
		class: className = 'flex-1',
		buttonLabel = m['search.submit'](),
		clearLabel = m['search.clear'](),
		disabled = false,
		onsearch,
		onclear,
		clear = false,
		...attributes
	}: Omit<HTMLInputAttributes, 'value' | 'type' | 'class'> & {
		value?: string;
		input?: HTMLInputElement | null;
		label: string;
		class?: string;
		buttonLabel?: string;
		clearLabel?: string;
		disabled?: boolean;
		onsearch?: () => void;
		/** Clears the field; the trailing button switches to it while `clear` is true. */
		onclear?: () => unknown;
		clear?: boolean;
	} = $props();

	const clearing = $derived(clear && Boolean(onclear));

	async function runClear() {
		value = '';
		await onclear?.();
		await tick();
		input?.focus();
	}
</script>

<div class="flex min-w-0 items-center gap-2 {className}">
	<input
		{...attributes}
		type="search"
		aria-label={label}
		class="{filterControlClass} w-full min-w-0"
		autocomplete="off"
		bind:value
		bind:this={input}
	/>
	{#if clearing}
		<button type="button" class={primaryIconControlClass} aria-label={clearLabel} title={clearLabel} onclick={runClear}>
			<Icon name="x" class={controlIconClass} />
		</button>
	{:else}
		<button
			type={onsearch ? 'button' : 'submit'}
			class={primaryIconControlClass}
			aria-label={buttonLabel}
			title={buttonLabel}
			{disabled}
			onclick={onsearch}
		>
			<Icon name="search" class={controlIconClass} />
		</button>
	{/if}
</div>

<style>
	input::-webkit-search-cancel-button {
		-webkit-appearance: none;
		appearance: none;
		display: none;
	}
</style>
