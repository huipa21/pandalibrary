<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import Icon, { type IconName } from '#lib/bookview/Icon.svelte';
	import { colorName } from '#lib/bookview/highlights/labels.js';
	import { HIGHLIGHT_HEX, highlightColor } from '../../annotations.js';
	import type { Note } from '../../types.js';
	import type { ReaderController } from '../../session/reader-controller.svelte.js';
	import type { PanelEntry } from './panel-model.js';
	import { entryLabel } from './labels.js';
	import BookNotes from './BookNotes.svelte';

	let { entry, controller, onjump, ondelete, ondeleteNote, registerGuard, readonly = false }: {
		entry: PanelEntry;
		controller: ReaderController;
		onjump: (entry: PanelEntry) => Promise<void>;
		ondelete: (entry: PanelEntry) => Promise<void>;
		ondeleteNote: (note: Note) => Promise<void>;
		registerGuard: (guard: () => boolean) => () => void;
		readonly?: boolean;
	} = $props();
	let editing = $state(false);
	let value = $state('');
	let original = $state('');
	const icons: Record<PanelEntry['kind'], IconName> = {
		mark: 'highlighter', bookmark: 'bookmark-plus', text: 'type', ink: 'pen', image: 'image'
	};
	const date = $derived(new Date(entry.createdAt));
	const dateLabel = $derived(Number.isFinite(date.getTime())
		? new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(date) : '');
	const icon = $derived(entry.kind === 'mark' && entry.style !== 'highlight'
		? entry.style === 'underline' ? 'underline' : 'strikethrough' : icons[entry.kind]);
	function guard() {
		return !editing || value === original || window.confirm(m['pv10.discard']());
	}
	onMount(() => registerGuard(guard));
	function edit() {
		if (!guard()) return;
		value = entry.kind === 'bookmark' ? entry.row.label : entry.kind === 'text' && entry.row.kind === 'text' ? entry.row.data.text : '';
		original = value;
		editing = true;
	}
	async function save() {
		const saved = entry.kind === 'bookmark'
			? await controller.updateBookmark(entry.row, { label: value })
			: entry.kind === 'text' && entry.row.kind === 'text'
				? await controller.updatePageAnnotation(entry.row, { data: { ...entry.row.data, text: value } })
				: false;
		if (saved) editing = false;
	}
</script>

<li class="pv10-entry space-y-3 rounded-lg border border-[var(--shell-border)] p-3" data-panel-entry={entry.id} data-panel-kind={entry.kind}>
	<button
		type="button"
		class="flex w-full items-start gap-2 text-left"
		data-panel-jump={entry.id}
		data-panel-kind={entry.kind}
		disabled={readonly}
		onclick={() => onjump(entry)}
	>
		<span class="mt-0.5 shrink-0" style:color={entry.kind === 'mark' ? HIGHLIGHT_HEX[highlightColor(entry.color)] : undefined}>
			<Icon name={icon} />
		</span>
		<span class="min-w-0 flex-1">
			<span class="block text-xs font-semibold">{entryLabel(entry)}{entry.kind === 'mark' ? ` · ${colorName(entry.color)}` : ''}</span>
			<span class="mt-1 block text-sm break-words whitespace-pre-line">{entry.excerpt || entryLabel(entry)}</span>
			{#if dateLabel}<time class="mt-1 block text-xs opacity-70" datetime={entry.createdAt}>{dateLabel}</time>{/if}
		</span>
	</button>
	{#if editing}
		<form class="space-y-2" onsubmit={(event) => { event.preventDefault(); void save(); }}>
			<label class="block text-sm">
				{entry.kind === 'bookmark' ? m['ux6.label']() : m['pv10.text']()}
				<textarea class="mt-1 w-full rounded border p-2" bind:value rows="3"></textarea>
			</label>
			<div class="flex gap-3 text-sm">
				<button type="submit" disabled={controller.busy || (entry.kind === 'text' && !value.trim())}>{m['ux6.save']()}</button>
				<button type="button" disabled={controller.busy} onclick={() => { if (guard()) editing = false; }}>{m['ux6.cancel']()}</button>
			</div>
		</form>
	{/if}
	{#if !readonly}
		<div class="flex justify-end gap-2">
			{#if entry.kind === 'bookmark' || entry.kind === 'text'}
				<button type="button" class="rounded p-1" aria-label={m['pv10.edit_entry']({ kind: entryLabel(entry) })} title={m['pv10.edit_entry']({ kind: entryLabel(entry) })} disabled={controller.busy} onclick={edit}><Icon name="pencil" class="size-4" /></button>
			{/if}
			<button type="button" class="rounded p-1" aria-label={m['pv10.delete_entry']({ kind: entryLabel(entry) })} title={m['pv10.delete_entry']({ kind: entryLabel(entry) })} disabled={controller.busy} onclick={() => ondelete(entry)}><Icon name="trash" class="size-4" /></button>
		</div>
	{/if}
	{#if entry.kind === 'mark'}
		<BookNotes notes={entry.notes} {controller} highlightId={entry.id} {registerGuard} ondelete={ondeleteNote} {readonly} />
	{/if}
</li>
