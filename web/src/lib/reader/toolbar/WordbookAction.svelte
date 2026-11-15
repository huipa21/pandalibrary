<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import type { EntryKind } from '#lib/wordbooks/api.js';
	import type { ReaderSelection } from '../types.js';
	import type { ReaderController } from '../session/reader-controller.svelte.js';
	import { captureWordbookSelection, selectionKind } from '../wordbook-selection.js';

	let { controller, capture, onadded, onretain, classify = false }: {
		controller: ReaderController;
		capture: () => ReaderSelection | null;
		onadded: () => void;
		onretain?: () => void;
		classify?: boolean;
	} = $props();
	let chosen = $state.raw<ReaderSelection | null>(null);
	let kind = $state<EntryKind>('word');
	let destination = $state('');
	$effect(() => { if (classify) void controller.loadWordbookDestinations(); });
	const labels = {
		word: () => m['wordbooks.word'](), phrase: () => m['wordbooks.phrase'](),
		sentence: () => m['wordbooks.sentence'](), passage: () => m['wordbooks.passage']()
	};
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
	async function add() {
		remember();
		if (await controller.addToWordbook(chosen, classify ? kind : undefined, classify && destination ? Number(destination) : undefined)) {
			chosen = null;
			onadded();
		}
	}
</script>

{#if classify}
	<select class="wordbook-kind" aria-label={m['wordbooks.destination']()} data-testid="wordbook-destination"
		bind:value={destination} disabled={controller.wordbookBusy} onpointerdown={remember} onfocus={remember}>
		<option value="">{m['wordbooks.default']()}</option>
		{#each controller.wordbookDestinations.filter((item) => !item.is_default) as item (item.id)}
			<option value={String(item.id)}>{item.name}</option>
		{/each}
	</select>
	<select class="wordbook-kind" aria-label={m['wordbooks.kind']()} data-testid="wordbook-kind"
		value={chosen ? kind : selectionKind(capture()?.text ?? '', capture()?.paragraphCount)}
		disabled={controller.wordbookBusy}
		onpointerdown={remember} onfocus={remember}
		onchange={(event) => {
			const override = event.currentTarget.value as EntryKind;
			remember();
			kind = override;
		}}>
		{#each Object.entries(labels) as [value, label]}<option {value}>{label()}</option>{/each}
	</select>
{/if}
<button type="button" class="pv4-button" data-roving data-testid={classify ? 'selection-wordbook-add' : 'reader-wordbook-add'}
	aria-label={controller.wordbookBusy ? m['wordbooks.saving']() : m['wordbooks.add']()}
	title={m['wordbooks.add']()} disabled={!controller.ready || controller.wordbookBusy}
	onpointerdown={keep} onfocus={remember} onclick={() => void add()}>
	<Icon name="bookmark-plus" />
</button>

<style>
	.wordbook-kind { max-width: 7rem; min-height: 32px; background: var(--pv-chrome, white); color: inherit; border: 1px solid var(--shell-border, #cbd5e1); border-radius: 4px; font: inherit; }
</style>
