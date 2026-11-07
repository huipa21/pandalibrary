<script lang="ts">
	import { tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import Icon from './Icon.svelte';
	import { nextRating, ratingStars } from './rating.js';

	type Props = {
		value: number | null;
		size?: 'sm' | 'md' | 'lg';
	} & (
		| { editable: true; onChange: (value: number | null) => void }
		| { editable?: false; onChange?: (value: number | null) => void }
	);

	let { value, editable = false, onChange, size = 'md' }: Props = $props();
	let group = $state<HTMLDivElement | null>(null);
	const fills = $derived(ratingStars(value));
	const iconSize = $derived(size === 'sm' ? 'size-4' : size === 'lg' ? 'size-7' : 'size-5');
	const formatted = $derived(value === null ? '' : new Intl.NumberFormat(getLocale(), {
		maximumFractionDigits: 1
	}).format(value / 2));

	function choose(next: number | null) {
		if (!onChange) throw new Error('Editable ratings require an onChange handler.');
		onChange(next);
	}

	async function handleKey(event: KeyboardEvent) {
		const next = nextRating(value, event.key);
		if (next === null) return;
		event.preventDefault();
		choose(next);
		await tick();
		group?.querySelector<HTMLButtonElement>(`[data-rating="${next}"]`)?.focus();
	}

	async function clear() {
		choose(null);
		await tick();
		group?.querySelector<HTMLButtonElement>('[data-rating="1"]')?.focus();
	}

	function choiceLabel(rating: number): string {
		return m['bv3.rating_choice']({
			rating: new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(rating / 2)
		});
	}
</script>

{#if editable || value !== null}
	<div class="inline-flex flex-wrap items-center gap-2">
		{#if editable}
			<div bind:this={group} class="inline-flex gap-0.5 text-amber-600" role="radiogroup" tabindex="-1" aria-label={m['bv3.rating']()} onkeydown={handleKey}>
				{#each fills as fill, index}
					<span class="relative inline-flex">
						<Icon name={fill === 'half' ? 'star-half' : 'star'} class={`${iconSize} ${fill === 'full' ? 'fill-current' : ''}`} />
						{#each [index * 2 + 1, index * 2 + 2] as rating}
							<button
								type="button"
								role="radio"
								class={`absolute inset-y-0 w-1/2 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-700 ${rating % 2 ? 'left-0' : 'right-0'}`}
								data-rating={rating}
								aria-label={choiceLabel(rating)}
								aria-checked={value === rating}
								tabindex={value === rating || (value === null && rating === 1) ? 0 : -1}
								onclick={() => choose(rating)}
							></button>
						{/each}
					</span>
				{/each}
			</div>
		{:else}
			<span class="inline-flex gap-0.5 text-amber-600" role="img" aria-label={m['bv3.rating_choice']({ rating: formatted })}>
				{#each fills as fill}
					<Icon name={fill === 'half' ? 'star-half' : 'star'} class={`${iconSize} ${fill === 'full' ? 'fill-current' : ''}`} />
				{/each}
			</span>
		{/if}
		{#if value !== null}<span class="text-sm text-slate-700" aria-hidden="true">{formatted}/5</span>{/if}
		{#if editable && value !== null}
			<button type="button" class="rounded text-sm text-slate-600 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-emerald-700" onclick={clear}>{m['bv3.rating_clear']()}</button>
		{/if}
	</div>
{/if}
