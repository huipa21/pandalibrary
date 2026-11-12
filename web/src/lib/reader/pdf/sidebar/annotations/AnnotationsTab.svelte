<script lang="ts">
	import { onMount, tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { isPdfLocator, type Note } from '../../../types.js';
	import { getPdfReaderContext } from '../../context.js';
	import { buildAnnotationList, filterEntries, type AnnotationEntry } from './annotations-list.js';
	import { VIRTUAL_THRESHOLD } from './virtual-window.js';
	import AnnotationDialog from './AnnotationDialog.svelte';
	import BookNotes from './BookNotes.svelte';
	import VirtualList from './VirtualList.svelte';
	import './annotations.css';

	const ctx = getPdfReaderContext();
	const controller = ctx.controller;
	let root = $state<HTMLElement>();
	let scrollRoot = $state<HTMLElement>();
	let query = $state('');
	let otherOpen = $state(false);
	let selected = $state<{ entry: AnnotationEntry; readonly: boolean; trigger: HTMLButtonElement } | null>(null);
	let reveal = $state<{ id: string; seq: number; other: boolean } | null>(null);
	let flashed = $state<AnnotationEntry | null>(null);
	let undo = $state<Parameters<typeof controller.restoreDeletedAnnotation>[0] | null>(null);
	let undoTimer: ReturnType<typeof setTimeout> | undefined;
	let flashTimer: ReturnType<typeof setTimeout> | undefined;
	let noteFlashTimer: ReturnType<typeof setTimeout> | undefined;
	let jumpVersion = 0;
	let handledReveal = 0;
	const guards = new Set<() => boolean>();

	const list = $derived(buildAnnotationList({
		highlights: controller.highlights, notes: controller.notes,
		pageAnnotations: [...controller.pageAnnotations, ...controller.otherPageAnnotations],
		fileId: controller.file?.id ?? -1
	}));
	const entries = $derived(filterEntries(list.entries, query));
	const other = $derived(filterEntries(list.otherFile, query));
	const virtual = $derived(entries.length + other.length > VIRTUAL_THRESHOLD);
	const dialogEntry = $derived(selected
		? [...list.entries, ...list.otherFile].find((entry) =>
			entry.id === selected?.entry.id && entry.kind === selected.entry.kind) ?? selected.entry
		: null);

	function registerGuard(guard: () => boolean) {
		guards.add(guard);
		return () => { guards.delete(guard); };
	}
	function canDiscard() { return [...guards].every((guard) => guard()); }

	onMount(() => {
		const unregisterDraft = controller.registerDraftGuard(canDiscard);
		const unregisterTab = ctx.sidebar.registerGuard(canDiscard);
		const unregisterPainter = ctx.engine.pageLayers.register({
			name: 'annotation-focus', z: 50,
			paint(context) {
				context.layer.style.pointerEvents = 'none';
				if (flashed?.page !== context.page) return;
				const rects = flashed.kind === 'mark' && isPdfLocator(flashed.row.locator)
					? flashed.row.locator.rects : flashed.rect ? [flashed.rect] : undefined;
				for (const rect of rects?.length ? rects : [{ x: 0.02, y: 0.02, width: 0.96, height: 0.96 }]) {
					const outline = document.createElement('div');
					outline.dataset.panelFlash = flashed.id;
					outline.className = 'rp7-page-flash';
					Object.assign(outline.style, {
						position: 'absolute', outline: '3px solid #10b981', outlineOffset: '3px',
						...context.toCss(rect)
					});
					context.layer.append(outline);
				}
			}
		});
		return () => {
			jumpVersion += 1;
			clearTimeout(undoTimer);
			clearTimeout(flashTimer);
			clearTimeout(noteFlashTimer);
			unregisterPainter();
			unregisterTab();
			unregisterDraft();
		};
	});

	async function jump(entry: AnnotationEntry): Promise<boolean> {
		if (entry.page === null || entry.row.book_file_id !== controller.file?.id) return false;
		const version = ++jumpVersion;
		try {
			await ctx.engine.goToPage(entry.page, entry.y);
			if (version !== jumpVersion) return false;
			const previous = flashed?.page;
			clearTimeout(flashTimer);
			flashed = entry;
			if (previous && previous !== entry.page) ctx.engine.pageLayers.repaint(previous);
			ctx.engine.pageLayers.repaint(entry.page);
			flashTimer = setTimeout(() => {
				flashed = null;
				if (entry.page !== null) ctx.engine.pageLayers.repaint(entry.page);
			}, 1000);
			if (!ctx.sidebar.docked) ctx.sidebar.collapse();
			return true;
		} catch (error) {
			console.error('Could not jump to annotation', error);
			ctx.announce(m['reader.error.render']());
			return false;
		}
	}

	async function dialogJump(entry: AnnotationEntry): Promise<boolean> {
		return canDiscard() && await jump(entry);
	}

	function offerUndo(value: NonNullable<typeof undo>) {
		undo = value;
		clearTimeout(undoTimer);
		undoTimer = setTimeout(() => { undo = null; }, 8000);
		ctx.announce(m['pv10.deleted']());
	}
	async function remove(entry: AnnotationEntry): Promise<boolean> {
		if (!canDiscard()) return false;
		if (entry.kind === 'mark') {
			if (await controller.removeHighlight(entry.row, { confirm: false })) {
				offerUndo({ kind: 'mark', row: entry.row, notes: entry.notes });
				return true;
			}
		} else if (await controller.removePageAnnotation(entry.row)) {
			offerUndo({ kind: 'insert', row: entry.row });
			return true;
		}
		return false;
	}
	async function removeNote(note: Note) {
		if (!canDiscard()) return;
		if (await controller.deleteNote(note)) offerUndo({ kind: 'note', row: note });
	}
	async function restore() {
		if (!undo) return;
		if (await controller.restoreDeletedAnnotation(undo)) {
			clearTimeout(undoTimer);
			undo = null;
		}
	}

	function expand(entry: AnnotationEntry, trigger: HTMLButtonElement, readonly: boolean) {
		selected = { entry, readonly, trigger };
	}
	function closeDialog(restoreFocus: boolean, checkDraft = true) {
		if (checkDraft && !canDiscard()) return;
		const trigger = selected?.trigger;
		selected = null;
		if (restoreFocus) void tick().then(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
		else if (!ctx.sidebar.open) ctx.engine.viewport.focus({ preventScroll: true });
	}

	$effect(() => {
		const target = ctx.sidebar.target;
		if (!target || target.seq === handledReveal || !ctx.sidebar.open || ctx.sidebar.tab !== 'annotations') return;
		const matches = (entry: AnnotationEntry) => target.kind === 'note'
			? entry.kind === 'mark' && entry.notes.some((note) => note.id === target.id)
			: target.kind === 'mark' ? entry.kind === 'mark' && entry.id === target.id
				: target.kind === 'insert' && entry.kind !== 'mark' && entry.id === target.id;
		const current = list.entries.find(matches);
		const fromOther = current ? undefined : list.otherFile.find(matches);
		const found = current ?? fromOther;
		if (found) {
			handledReveal = target.seq;
			if (!filterEntries([found], query).length) query = '';
			if (fromOther) otherOpen = true;
			reveal = { id: found.id, seq: target.seq, other: !!fromOther };
		} else if (target.kind === 'note' && list.bookNotes.some((note) => note.id === target.id)) {
			handledReveal = target.seq;
			void tick().then(() => {
				const item = [...(root?.querySelectorAll<HTMLElement>('[data-note-id]') ?? [])]
					.find((element) => element.dataset.noteId === target.id);
				item?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
				item?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
				item?.classList.add('rp7-note-flash');
				clearTimeout(noteFlashTimer);
				noteFlashTimer = setTimeout(() => item?.classList.remove('rp7-note-flash'), 1000);
			});
		}
	});
</script>

<div class="rp7-tab" bind:this={root}>
	<header class="rp7-header">
		<input type="search" aria-label={m['pv10.search']()} placeholder={m['pv10.search']()} bind:value={query} />
		<span class="rp7-count">{m['rp7.count']({ count: list.count })}</span>
	</header>
	{#if controller.actionError || controller.pendingError}
		<div role="alert" class="rp7-error">
			<p>{controller.actionError || controller.pendingError}</p>
			{#if controller.pendingError}
				<button type="button" class="rp7-link" onclick={() => controller.retryWrites()}>{m['reader.retry_saves']()}</button>
			{/if}
		</div>
	{/if}
	<div class="rp7-content" bind:this={scrollRoot}>
		{#if !entries.length && (!query.trim() || !other.length)}
			<p class="rp7-empty">{query.trim() ? m['rp7.no_match']() : m['rp7.empty']()}</p>
		{/if}
		<VirtualList
			{entries}
			{scrollRoot}
			{virtual}
			busy={controller.busy}
			target={reveal && !reveal.other ? reveal : null}
			onjump={jump}
			ondelete={remove}
			onexpand={expand}
		/>
		{#if other.length}
			<details class="rp7-other" bind:open={otherOpen}>
				<summary>{m['rp7.other_files']()} ({other.length})</summary>
				<VirtualList
					entries={other}
					{scrollRoot}
					{virtual}
					readonly
					busy={controller.busy}
					target={reveal?.other ? reveal : null}
					onjump={jump}
					ondelete={remove}
					onexpand={expand}
				/>
			</details>
		{/if}
		<section class="rp7-book-notes" aria-labelledby="rp7-book-notes">
			<h3 id="rp7-book-notes">{m['reader.annotations.book_notes']()}</h3>
			<BookNotes notes={list.bookNotes} {controller} {registerGuard} ondelete={removeNote} />
		</section>
	</div>
	{#if undo}
		<div role="status" class="rp7-undo">
			{m['pv10.deleted']()}
			<button type="button" class="rp7-link" disabled={controller.busy} onclick={restore}>{m['pv10.undo']()}</button>
		</div>
	{/if}
</div>
{#if selected && dialogEntry}
	<AnnotationDialog
		entry={dialogEntry}
		readonly={selected.readonly}
		{controller}
		{registerGuard}
		ondeleteNote={removeNote}
		onclose={closeDialog}
		onjump={dialogJump}
		ondelete={remove}
	/>
{/if}
