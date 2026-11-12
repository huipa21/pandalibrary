<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { v7 as uuidv7 } from 'uuid';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import { focusableWithin, nextTrappedFocus } from '#lib/shell/focus.js';
	import { annotationAssetUrl, releaseAnnotationAssetUrl } from '../../../assets/asset-cache.js';
	import type { HighlightStyle, Note, TextData } from '../../../types.js';
	import type { NoteDraft, ReaderController } from '../../../session/reader-controller.svelte.js';
	import StickyNote from '../../../StickyNote.svelte';
	import { highlightColor } from '../../../annotations.js';
	import ColorPalette from '../../marks/ColorPalette.svelte';
	import { strokePath } from '../../insert/ink.js';
	import type { AnnotationEntry } from './annotations-list.js';
	import { entryLabel, markColorName } from './labels.js';
	import DeleteButton from './DeleteButton.svelte';

	let { entry, readonly, controller, registerGuard, ondeleteNote, onclose, onjump, ondelete, editComments = false }: {
		entry: AnnotationEntry;
		readonly: boolean;
		controller: ReaderController;
		registerGuard: (guard: () => boolean) => () => void;
		ondeleteNote: (note: Note) => Promise<void>;
		onclose: (restoreFocus: boolean, checkDraft?: boolean) => void;
		onjump: (entry: AnnotationEntry) => Promise<boolean>;
		ondelete: (entry: AnnotationEntry) => Promise<boolean>;
		editComments?: boolean;
	} = $props();
	let dialog = $state<HTMLDialogElement>();
	let closeButton = $state<HTMLButtonElement>();
	let imageUrl = $state<string | null>(null);
	let imageError = $state(false);
	let imageLoading = $state(false);
	let retryImage = $state(0);
	let draft = $state<NoteDraft | null>(null);
	let textDraft = $state<TextData | null>(null);
	let textOriginal = $state('');
	function guard() {
		const dirty = (draft && draft.body !== draft.original) ||
			(textDraft && JSON.stringify(textDraft) !== textOriginal);
		return !dirty || window.confirm(m['reader.note.discard_confirm']());
	}
	function editNote(note?: Note) {
		if (!guard()) return;
		draft = {
			id: note?.id ?? uuidv7(), highlightId: entry.id, body: note?.body_md ?? '',
			original: note?.body_md ?? '', editing: !!note
		};
	}
	async function saveNote(body: string) {
		if (!draft) return;
		draft.body = body;
		if (await controller.saveNote(draft)) draft = null;
	}
	async function saveText() {
		if (!textDraft || entry.kind === 'mark' || entry.row.kind !== 'text' || !textDraft.text.trim()) return;
		if (await controller.updatePageAnnotation(entry.row, { kind: 'text', data: { ...textDraft } })) textDraft = null;
	}
	const markStyles: { value: HighlightStyle; label: () => string }[] = [
		{ value: 'highlight', label: () => m['pv8.highlight']() },
		{ value: 'underline', label: () => m['pv8.underline']() },
		{ value: 'strikeout', label: () => m['pv8.strikeout']() }
	];
	const title = $derived(entry.page === null
		? m['rp7.title_other']({ kind: entryLabel(entry) })
		: m['rp7.title']({ kind: entryLabel(entry), page: entry.page }));
	const color = $derived(entry.kind === 'mark' ? entry.swatch.hex
		: entry.row.kind === 'text' || entry.row.kind === 'ink' ? entry.row.data.color : null);
	const imageHash = $derived(entry.kind === 'image' && entry.row.kind === 'image' ? entry.row.data.asset : null);

	function fullStamp(value: string) {
		const date = new Date(value);
		return Number.isFinite(date.getTime())
			? new Intl.DateTimeFormat(getLocale(), { dateStyle: 'full', timeStyle: 'short' }).format(date)
			: value;
	}

	onMount(() => {
		const unregister = registerGuard(guard);
		dialog?.showModal();
		closeButton?.focus();
		if (editComments && entry.kind === 'mark' && !readonly) editNote(entry.notes[0]);
		else if (editComments && entry.kind !== 'mark' && entry.row.kind === 'text' && !readonly) {
			textDraft = { ...entry.row.data };
			textOriginal = JSON.stringify(textDraft);
			void tick().then(() => dialog?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true }));
		}
		const escape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || !dialog?.open) return;
			event.preventDefault();
			event.stopPropagation();
			onclose(true);
		};
		window.addEventListener('keydown', escape, true);
		return () => {
			unregister();
			window.removeEventListener('keydown', escape, true);
			if (dialog?.open) dialog.close();
		};
	});

	$effect(() => {
		const hash = imageHash;
		void retryImage;
		if (!hash) return;
		const abort = new AbortController();
		let acquired: string | null = null;
		imageUrl = null;
		imageError = false;
		imageLoading = true;
		void annotationAssetUrl(hash, abort.signal).then((url) => {
			if (abort.signal.aborted) releaseAnnotationAssetUrl(url);
			else { acquired = url; imageUrl = url; imageLoading = false; }
		}).catch((error: unknown) => {
			if (abort.signal.aborted) return;
			console.error('Could not load annotation image', error);
			imageError = true;
			imageLoading = false;
		});
		return () => {
			abort.abort();
			if (acquired) releaseAnnotationAssetUrl(acquired);
		};
	});

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.stopPropagation();
			return;
		}
		if (event.key !== 'Tab') return;
		const next = nextTrappedFocus(focusableWithin(dialog ?? null), document.activeElement, event.shiftKey);
		if (next) { event.preventDefault(); next.focus(); }
	}

	async function jump() {
		if (await onjump(entry)) onclose(false, false);
	}
	async function remove() {
		if (await ondelete(entry)) onclose(false, false);
	}
</script>

<dialog
	bind:this={dialog}
	class="rp7-dialog"
	aria-labelledby="rp7-dialog-title"
	oncancel={(event) => { event.preventDefault(); onclose(true); }}
	{onkeydown}
>
	<header class="rp7-dialog-header">
		<h2 id="rp7-dialog-title">{title}</h2>
		<button bind:this={closeButton} type="button" class="rp7-icon-button" aria-label={m['rp7.close']()} title={m['rp7.close']()} onclick={() => onclose(true)}>
			<Icon name="x" class="size-4" />
		</button>
	</header>
	<div class="rp7-dialog-body">
		{#if controller.actionError || controller.pendingError}
			<div role="alert" class="rp7-dialog-error">
				<p>{controller.actionError || controller.pendingError}</p>
				{#if controller.pendingError}
					<button type="button" class="rp7-link" onclick={() => controller.retryWrites()}>{m['reader.retry_saves']()}</button>
				{/if}
			</div>
		{/if}
		<dl class="rp7-metadata">
			{#if color}
				<div><dt>{m['rp7.color']()}</dt><dd><span class="rp7-color-chip" style:background-color={color}></span>{markColorName(color)}</dd></div>
			{/if}
			<div><dt>{m['rp7.created']()}</dt><dd><time datetime={entry.createdAt} title={entry.createdAt}>{fullStamp(entry.createdAt)}</time></dd></div>
			<div><dt>{m['rp7.updated']()}</dt><dd><time datetime={entry.updatedAt} title={entry.updatedAt}>{fullStamp(entry.updatedAt)}</time></dd></div>
		</dl>
		{#if entry.kind === 'mark'}
			<blockquote class="rp7-quote">{entry.row.text}</blockquote>
			{#if editComments && !readonly}
				<ColorPalette value={highlightColor(entry.row.color)} label={m['reader.annotations.color']()} disabled={controller.busy} onpick={(color) => { if (entry.kind === 'mark') void controller.updateHighlight(entry.row, { color }); }} />
				<div class="my-3 flex flex-wrap gap-2" role="group" aria-label={m['pv8.style']()}>
					{#each markStyles as style}
						<button type="button" class="rp7-footer-button" aria-pressed={(entry.row.style ?? 'highlight') === style.value} disabled={controller.busy} onclick={() => { if (entry.kind === 'mark') void controller.updateHighlight(entry.row, { style: style.value }); }}>{style.label()}</button>
					{/each}
				</div>
			{/if}
		{:else if entry.row.kind === 'text'}
			{#if textDraft && !readonly}
				<form class="space-y-3" onsubmit={(event) => { event.preventDefault(); void saveText(); }}>
					<textarea class="min-h-36 w-full rounded border border-[var(--shell-border)] p-2" aria-label={m['pv9.text']()} maxlength="4000" bind:value={textDraft.text} readonly={controller.busy}></textarea>
					<div class="flex flex-wrap items-center gap-3">
						<label>{m['pv9.color']()} <input type="color" bind:value={textDraft.color} disabled={controller.busy} /></label>
						<label>{m['pv9.size']()} <select bind:value={textDraft.size} disabled={controller.busy}><option value={0.012}>S</option><option value={0.018}>M</option><option value={0.028}>L</option></select></label>
					</div>
					<div class="flex gap-3">
						<button type="submit" class="rp7-footer-button" disabled={controller.busy || !textDraft.text.trim()}>{m['pv9.done']()}</button>
						<button type="button" class="rp7-footer-button" disabled={controller.busy} onclick={() => { if (guard()) textDraft = null; }}>{m['reader.note.cancel']()}</button>
					</div>
				</form>
			{:else}
				<div class="rp7-full-text">{entry.row.data.text}</div>
			{/if}
		{:else if entry.row.kind === 'ink'}
			<svg
				class="rp7-ink-preview"
				role="img"
				aria-label={m['pv10.drawing']()}
				viewBox={`${entry.row.locator.rect.x} ${entry.row.locator.rect.y} ${entry.row.locator.rect.width} ${entry.row.locator.rect.height}`}
			>
				{#each entry.row.data.strokes as stroke}
					<path d={strokePath(stroke)} fill="none" stroke={entry.row.data.color} stroke-width={entry.row.data.width} stroke-linecap="round" stroke-linejoin="round" />
				{/each}
			</svg>
		{:else if entry.row.kind === 'image'}
			{#if imageLoading}
				<p role="status">{m['rp7.image_loading']()}</p>
			{:else if imageError}
				<div role="alert">
					<p>{m['rp7.image_error']()}</p>
					<button type="button" class="rp7-link" onclick={() => { retryImage += 1; }}>{m['rp7.retry_image']()}</button>
				</div>
			{:else if imageUrl}
				<img
					class="rp7-image-preview"
					src={imageUrl}
					alt={m['rp7.image_alt']()}
					onerror={() => { console.error('Could not decode annotation image'); imageError = true; imageUrl = null; }}
				/>
			{/if}
		{/if}
		{#if entry.kind === 'mark'}
			<section aria-labelledby="rp7-comments-title" class="rp7-dialog-comments">
				<h3 id="rp7-comments-title">{m['rp7.comments']()}</h3>
				{#each entry.notes as note (note.id)}
					<div class="my-3 rounded-sm border border-[#dfcf7b] bg-[#fff3af] p-3 text-[#493d1b]" data-note-id={note.id}>
						<p class="whitespace-pre-wrap break-words text-sm">{note.body_md}</p>
						{#if !readonly}
							<div class="mt-2 flex gap-3 text-xs">
								<button type="button" disabled={controller.busy} onclick={() => editNote(note)}>{m['reader.note.edit']()}</button>
								<button type="button" disabled={controller.busy} onclick={async () => { if (guard() && await ondeleteNote(note) && draft?.id === note.id) draft = null; }}>{m['reader.annotations.delete']()}</button>
							</div>
						{/if}
					</div>
				{/each}
				{#if draft}
					{#key draft.id}
						<StickyNote initial={draft.body} disabled={controller.busy} onchange={(body) => { if (draft) draft.body = body; }} onsave={(body) => { void saveNote(body); }} oncancel={(body) => { if (draft) draft.body = body; if (guard()) draft = null; }} />
					{/key}
				{:else if !readonly}
					<button type="button" class="rp7-link" disabled={controller.busy} onclick={() => editNote()}>{m['rp7.add_comment']()}</button>
				{/if}
			</section>
		{/if}
	</div>
	<footer class="rp7-dialog-footer">
		{#if !readonly}
			<button type="button" class="rp7-footer-button" disabled={controller.busy} onclick={jump}>{m['rp7.go_to_page']()}</button>
			<DeleteButton excerpt={entry.excerpt || entryLabel(entry)} busy={controller.busy} ondelete={remove} icon={false} />
		{/if}
	</footer>
</dialog>
