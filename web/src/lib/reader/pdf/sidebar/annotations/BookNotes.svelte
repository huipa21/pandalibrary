<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { v7 as uuidv7 } from 'uuid';
	import * as m from '#lib/paraglide/messages.js';
	import NoteEditor from '../../../NoteEditor.svelte';
	import { renderMarkdown } from '../../../markdown.js';
	import type { Note } from '../../../types.js';
	import type { NoteDraft, ReaderController } from '../../../session/reader-controller.svelte.js';

	let { notes, controller, highlightId = null, registerGuard, ondelete, readonly = false, addLabel }: {
		notes: Note[];
		controller: ReaderController;
		highlightId?: string | null;
		registerGuard: (guard: () => boolean) => () => void;
		ondelete: (note: Note) => Promise<void>;
		readonly?: boolean;
		addLabel?: string;
	} = $props();
	let root = $state<HTMLDivElement>();
	let draft = $state<NoteDraft | null>(null);
	$effect(() => {
		if (draft?.editing && !notes.some((note) => note.id === draft?.id)) draft = null;
	});
	function guard() {
		return !draft || draft.body === draft.original || window.confirm(m['reader.note.discard_confirm']());
	}
	onMount(() => registerGuard(guard));
	function edit(note?: Note) {
		if (!guard()) return;
		draft = {
			id: note?.id ?? uuidv7(), highlightId, body: note?.body_md ?? '',
			original: note?.body_md ?? '', editing: !!note
		};
	}
	async function save() {
		const id = draft?.id;
		if (!draft || !await controller.saveNote(draft)) return;
		draft = null;
		await tick();
		const saved = [...(root?.querySelectorAll<HTMLElement>('[data-note-id]') ?? [])]
			.find((element) => element.dataset.noteId === id);
		saved?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
	}
</script>

<div class="space-y-3" bind:this={root}>
	{#each notes as note (note.id)}
		<div class="rounded border border-[var(--shell-border)] p-2" data-note-id={note.id}>
			<div class="reader-markdown text-sm break-words">{@html renderMarkdown(note.body_md)}</div>
			{#if !readonly}
				<div class="mt-2 flex gap-3 text-xs">
					<button type="button" disabled={controller.busy} onclick={() => edit(note)}>{m['reader.note.edit']()}</button>
					<button type="button" disabled={controller.busy} onclick={() => ondelete(note)}>{m['reader.annotations.delete']()}</button>
				</div>
			{/if}
		</div>
	{/each}
	{#if draft}
		<form class="space-y-2" onsubmit={(event) => { event.preventDefault(); void save(); }}>
			{#key draft.id}<NoteEditor value={draft.body} onChange={(value) => { if (draft) draft.body = value; }} />{/key}
			<div class="flex gap-3 text-sm">
				<button type="submit" disabled={controller.busy || !draft.body.trim()}>{m['reader.note.save']()}</button>
				<button type="button" disabled={controller.busy} onclick={() => { if (guard()) draft = null; }}>{m['reader.note.cancel']()}</button>
			</div>
		</form>
	{:else if !readonly}
		<button type="button" class="text-sm underline" disabled={controller.busy} onclick={() => edit()}>
			{addLabel ?? (highlightId ? m['reader.annotations.attach_note']() : m['reader.annotations.add_note']())}
		</button>
	{/if}
</div>
