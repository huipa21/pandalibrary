<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import type { EntryKind } from '#lib/wordbooks/api.js';
	import type { ReaderSelection } from '../types.js';
	import type { ReaderController } from '../session/reader-controller.svelte.js';
	import {
		captureWordbookSelection, orderWordbookDestinations, readWordbookUsage,
		recordWordbookUsage, selectionKind, writeWordbookUsage
	} from '../wordbook-selection.js';

	let { controller, capture, onadded, onretain, classify = false }: {
		controller: ReaderController;
		capture: () => ReaderSelection | null;
		onadded: () => void;
		onretain?: () => void;
		classify?: boolean;
	} = $props();
	let chosen = $state.raw<ReaderSelection | null>(null);
	let kind = $state<EntryKind>('word');
	let open = $state(false);
	let loading = $state(false);
	let usage = $state.raw(readWordbookUsage());
	let host = $state<HTMLDivElement>();
	let trigger = $state<HTMLButtonElement>();
	const kinds: EntryKind[] = ['word', 'phrase', 'sentence', 'passage'];
	const labels = {
		word: () => m['wordbooks.word'](), phrase: () => m['wordbooks.phrase'](),
		sentence: () => m['wordbooks.sentence'](), passage: () => m['wordbooks.passage']()
	};
	const destinations = $derived(orderWordbookDestinations(controller.wordbookDestinations, usage));

	function remember() {
		const next = captureWordbookSelection(capture());
		if (next) onretain?.();
		if (next && JSON.stringify(next.locator) !== JSON.stringify(chosen?.locator)) {
			kind = selectionKind(next.text, next.paragraphCount);
			chosen = next;
		}
	}
	function keep(event: PointerEvent) {
		if (!classify) chosen = null;
		remember();
		event.preventDefault();
	}
	async function activate() {
		remember();
		if (!classify) {
			await add();
			return;
		}
		if (open) {
			open = false;
			return;
		}
		open = true;
		onretain?.();
		if (!controller.wordbookDestinations.length && !loading) {
			loading = true;
			await controller.loadWordbookDestinations();
			loading = false;
		}
	}
	async function add(destination?: number) {
		remember();
		if (await controller.addToWordbook(chosen, classify ? kind : undefined, classify ? destination : undefined)) {
			if (classify) {
				const used = destination ?? controller.wordbookDestinations.find((item) => item.is_default)?.id;
				if (used !== undefined) {
					usage = recordWordbookUsage(usage, used);
					writeWordbookUsage(usage);
				}
			}
			open = false;
			chosen = null;
			onadded();
		}
	}
	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !open) return;
		event.preventDefault();
		event.stopPropagation();
		open = false;
		trigger?.focus({ preventScroll: true });
	}

	$effect(() => {
		if (!open) return;
		const close = (event: PointerEvent) => {
			if (event.target instanceof Node && host?.contains(event.target)) return;
			open = false;
		};
		document.addEventListener('pointerdown', close, true);
		return () => document.removeEventListener('pointerdown', close, true);
	});
</script>

<div bind:this={host} class="pv8-wordbook-action">
	<button bind:this={trigger} type="button" class="pv4-button" data-roving
		data-testid={classify ? 'selection-wordbook-add' : 'reader-wordbook-add'}
		aria-label={controller.wordbookBusy ? m['wordbooks.saving']() : m['wordbooks.add']()}
		aria-haspopup={classify ? 'dialog' : undefined}
		aria-expanded={classify ? open : undefined}
		title={m['wordbooks.add']()} disabled={!controller.ready || controller.wordbookBusy}
		onpointerdown={keep} onfocus={remember} {onkeydown} onclick={() => void activate()}>
		<Icon name="notebook" />
	</button>
	{#if classify && open}
		<div class="pv8-wordbook-menu" role="dialog" tabindex="-1" aria-label={m['wordbooks.add']()} {onkeydown}>
			<p class="pv8-wordbook-heading">{m['wordbooks.kind']()}</p>
			<div class="pv8-wordbook-kinds" role="radiogroup" aria-label={m['wordbooks.kind']()}
				data-testid="wordbook-kind">
				{#each kinds as value (value)}
					<button type="button" role="radio" class="pv8-wordbook-kind"
						aria-checked={kind === value} data-testid={`wordbook-kind-${value}`}
						disabled={controller.wordbookBusy}
						onpointerdown={keep} onfocus={remember} onclick={() => { kind = value; }}>
						{labels[value]()}
					</button>
				{/each}
			</div>
			<p class="pv8-wordbook-heading">{m['wordbooks.destination']()}</p>
			<div class="pv8-wordbook-destinations" role="group" aria-label={m['wordbooks.destination']()}
				data-testid="wordbook-destination">
				{#if loading}
					<p class="pv4-hint">{m['wordbooks.loading']()}</p>
				{:else}
					{#each destinations as item (item.id)}
						<button type="button" class="pv8-wordbook-destination"
							data-testid={`wordbook-destination-${item.id}`}
							disabled={controller.wordbookBusy}
							onpointerdown={keep} onclick={() => void add(item.id)}>
							<span class="pv8-wordbook-name">{item.name}</span>
							{#if item.is_default}<span class="pv8-wordbook-badge">{m['wordbooks.default']()}</span>{/if}
						</button>
					{:else}
						<button type="button" class="pv8-wordbook-destination"
							disabled={controller.wordbookBusy}
							onpointerdown={keep} onclick={() => void add()}>
							<span class="pv8-wordbook-name">{m['wordbooks.default']()}</span>
						</button>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.pv8-wordbook-action { position: relative; display: inline-flex; }
	.pv8-wordbook-menu {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 2;
		box-sizing: border-box;
		width: min(18rem, calc(100vw - 16px));
		max-height: min(70vh, 22rem);
		overflow: auto;
		padding: 8px;
		border-radius: 12px;
		background: var(--pv-palette-bg, white);
		color: inherit;
		box-shadow: 0 10px 24px rgb(0 0 0 / 15%), 0 0 0 1px rgb(0 0 0 / 10%);
	}
	.pv8-wordbook-heading { margin: 4px 6px 6px; color: #64748b; font-size: 11px; font-weight: 600; text-transform: uppercase; }
	.pv8-wordbook-kinds { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; }
	.pv8-wordbook-kind, .pv8-wordbook-destination {
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.pv8-wordbook-kind {
		min-height: 30px;
		padding: 0 8px;
		border-radius: 7px;
		text-align: start;
	}
	.pv8-wordbook-kind:hover:not(:disabled), .pv8-wordbook-destination:hover:not(:disabled) { background: rgb(0 0 0 / 5%); }
	.pv8-wordbook-kind[aria-checked='true'] { background: rgb(16 185 129 / 15%); color: #047857; font-weight: 600; }
	.pv8-wordbook-kind:focus-visible, .pv8-wordbook-destination:focus-visible { outline: 2px solid #10b981; outline-offset: -2px; }
	.pv8-wordbook-kind:disabled, .pv8-wordbook-destination:disabled { cursor: default; opacity: .5; }
	.pv8-wordbook-destinations { display: grid; gap: 2px; }
	.pv8-wordbook-destination {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 34px;
		padding: 0 8px;
		border-radius: 7px;
		text-align: start;
	}
	.pv8-wordbook-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.pv8-wordbook-badge { flex: none; color: #64748b; font-size: 11px; }
	:global(:root[data-theme='dark']) .pv8-wordbook-menu { box-shadow: 0 10px 24px rgb(0 0 0 / 35%), 0 0 0 1px rgb(255 255 255 / 12%); }
	:global(:root[data-theme='dark']) .pv8-wordbook-kind:hover:not(:disabled),
	:global(:root[data-theme='dark']) .pv8-wordbook-destination:hover:not(:disabled) { background: rgb(255 255 255 / 8%); }
	:global(:root[data-theme='dark']) .pv8-wordbook-kind[aria-checked='true'] { color: #a7f3d0; }
</style>
