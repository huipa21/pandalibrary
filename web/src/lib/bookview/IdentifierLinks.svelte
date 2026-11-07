<script lang="ts">
	import type { Identifier } from '#lib/catalog/types.js';
	import * as m from '#lib/paraglide/messages.js';
	import Icon from './Icon.svelte';
	import { identifierLinks, type Provider } from './identifiers.js';

	let { identifiers, variant = 'icons' }: {
		identifiers: readonly Identifier[];
		variant?: 'icons' | 'chips';
	} = $props();
	const items = $derived(identifierLinks(identifiers));

	function providerName(provider: Provider): string {
		switch (provider) {
			case 'google': return m['bv3.provider_google']();
			case 'openlibrary': return m['bv3.provider_openlibrary']();
			case 'goodreads': return m['bv3.provider_goodreads']();
			case 'amazon': return m['bv3.provider_amazon']();
		}
	}

	function mark(provider: Provider): string {
		switch (provider) {
			case 'google': return 'G';
			case 'openlibrary': return 'OL';
			case 'goodreads': return 'GR';
			case 'amazon': return 'a';
		}
	}
</script>

{#if items.length}
	<div class="flex flex-wrap items-center gap-2">
		{#each items as item}
			{#if item.provider !== null}
				<a
					class={variant === 'icons'
						? 'inline-flex size-9 items-center justify-center rounded-md border border-slate-300 bg-white text-xs font-bold text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-700'
						: 'inline-flex max-w-full items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-emerald-700'}
					href={item.href}
					target="_blank"
					rel="noopener noreferrer"
					aria-label={m['bv3.provider_link']({ provider: providerName(item.provider), value: item.value })}
					title={m['bv3.provider_link']({ provider: providerName(item.provider), value: item.value })}
				>
					{#if variant === 'icons'}<span aria-hidden="true">{mark(item.provider)}</span>
					{:else}<span class="truncate">{providerName(item.provider)}: {item.value}</span><Icon name="external" class="size-3 shrink-0" />{/if}
				</a>
			{:else}
				<span class="max-w-full rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700 break-all">{item.scheme}: {item.value}</span>
			{/if}
		{/each}
	</div>
{/if}
