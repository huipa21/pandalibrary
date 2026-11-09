<script lang="ts">
	import { onMount, tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import { getPdfReaderContext } from '../context.js';
	import type { Note } from '../../types.js';
	import { buildPanel, filterEntries, PANEL_FILTERS, type PanelEntry as Entry, type PanelFilter } from './panel-model.js';
	import PanelEntry from './PanelEntry.svelte';
	import BookNotes from './BookNotes.svelte';

	const ctx = getPdfReaderContext();
	const controller = ctx.controller;
	let root = $state<HTMLElement>();
	let filter = $state<PanelFilter>('all');
	let query = $state('');
	let flashed = $state<Entry | null>(null);
	let undo = $state<Parameters<typeof controller.restoreDeletedAnnotation>[0] | null>(null);
	let undoTimer: ReturnType<typeof setTimeout>;
	let flashTimer: ReturnType<typeof setTimeout>;
	let jumpVersion = 0;
	const guards = new Set<() => boolean>();
	const panel = $derived(buildPanel({
		highlights: controller.highlights, notes: controller.notes, bookmarks: controller.bookmarks,
		pageAnnotations: controller.pageAnnotations, fileId: controller.file?.id ?? -1, format: 'pdf'
	}));
	const groups = $derived(panel.groups.map((group) => ({ ...group, entries: filterEntries(group.entries, filter, query) })).filter((group) => group.entries.length));
	const other = $derived(filterEntries(panel.otherFile, filter, query));
	const labels: Record<PanelFilter, () => string> = {
		all: m['pv10.all'], marks: m['pv10.marks'], comments: m['pv10.comments'],
		bookmarks: m['ux6.title'], inserts: m['pv10.inserts']
	};
	function registerGuard(guard: () => boolean) {
		guards.add(guard);
		return () => { guards.delete(guard); };
	}
	function canDiscard() { return [...guards].every((guard) => guard()); }
	function close() {
		if (!canDiscard()) return;
		ctx.panel.toggle();
		document.querySelector<HTMLButtonElement>('.pv-frame-toolbar button[aria-controls="pdf-annotations-panel"]')?.focus();
	}
	function onKeydown(event: KeyboardEvent) {
		if (!ctx.panel.open) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopImmediatePropagation();
			close();
		}
	}
	function onToggle(event: MouseEvent) {
		if (!ctx.panel.open || !(event.target instanceof Element) ||
			!event.target.closest('button[aria-controls="pdf-annotations-panel"]')) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		close();
	}
	onMount(() => {
		const unregisterGuard = controller.registerDraftGuard(canDiscard);
		window.addEventListener('keydown', onKeydown, true);
		window.addEventListener('click', onToggle, true);
		const unregister = ctx.engine.pageLayers.register({
			name: 'panel-focus', z: 50,
			paint(context) {
				context.layer.style.pointerEvents = 'none';
				if (flashed?.page !== context.page) return;
				const outline = document.createElement('div');
				outline.dataset.panelFlash = flashed.id;
				Object.assign(outline.style, {
					position: 'absolute', outline: '3px solid #10b981', outlineOffset: '3px',
					...context.toCss(flashed.rect ?? { x: 0.02, y: 0.02, width: 0.96, height: 0.96 })
				});
				context.layer.append(outline);
			}
		});
		return () => {
			jumpVersion += 1;
			clearTimeout(undoTimer);
			clearTimeout(flashTimer);
			unregister();
			window.removeEventListener('keydown', onKeydown, true);
			window.removeEventListener('click', onToggle, true);
			unregisterGuard();
		};
	});
	async function jump(entry: Entry) {
		if (entry.page === null || entry.row.book_file_id !== controller.file?.id) return;
		const version = ++jumpVersion;
		try {
			await ctx.engine.goToPage(entry.page, entry.y);
			if (version !== jumpVersion) return;
			clearTimeout(flashTimer);
			flashed = entry;
			ctx.engine.pageLayers.repaint();
			flashTimer = setTimeout(() => { flashed = null; ctx.engine.pageLayers.repaint(); }, 1000);
		} catch (error) {
			console.error('Could not jump to annotation', error);
			ctx.announce(m['reader.error.render']());
		}
	}
	$effect(() => {
		const target = ctx.panel.target;
		if (!ctx.panel.open) return;
		if (target) { filter = 'all'; query = ''; }
		void tick().then(() => {
			const kind = target?.kind;
			const selector = kind === 'note' ? '[data-note-id]' : '[data-panel-jump]';
			const element = target
				? [...(root?.querySelectorAll<HTMLElement>(selector) ?? [])].find((item) => {
					if (kind === 'note') return item.dataset.noteId === target.id;
					const matchesKind = kind === 'insert'
						? ['text', 'ink', 'image'].includes(item.dataset.panelKind ?? '')
						: item.dataset.panelKind === kind;
					return item.dataset.panelJump === target.id && matchesKind;
				})
				: root?.querySelector<HTMLInputElement>('input[type="search"]');
			element?.scrollIntoView({ block: 'nearest' });
			if (kind === 'note') {
				element?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
			} else element?.focus({ preventScroll: true });
		});
	});
	function offerUndo(entry: NonNullable<typeof undo>) {
		undo = entry;
		clearTimeout(undoTimer);
		undoTimer = setTimeout(() => { undo = null; }, 8000);
	}
	async function remove(entry: Entry) {
		if (!canDiscard()) return;
		if (entry.kind === 'mark') {
			if (await controller.removeHighlight(entry.row)) offerUndo({ kind: 'mark', row: entry.row, notes: entry.notes });
		} else if (entry.kind === 'bookmark') {
			if (await controller.removeBookmark(entry.row)) offerUndo({ kind: 'bookmark', row: entry.row });
		} else if (window.confirm(m['pv10.delete_confirm']())) {
			if (await controller.removePageAnnotation(entry.row)) offerUndo({ kind: 'insert', row: entry.row });
		}
	}
	async function removeNote(note: Note) {
		if (!canDiscard()) return;
		if (await controller.deleteNote(note)) offerUndo({ kind: 'note', row: note });
	}
	async function restore() {
		if (!undo) return;
		clearTimeout(undoTimer);
		if (await controller.restoreDeletedAnnotation(undo)) undo = null;
	}
</script>

{#if ctx.panel.open}
	<aside bind:this={root} id="pdf-annotations-panel" class="pv10-panel absolute inset-y-0 right-0 z-30 flex w-[360px] max-w-[90vw] flex-col border-l border-[var(--shell-border)] bg-[var(--shell-surface)] text-[var(--shell-text)] shadow-xl" aria-label={m['pv4.annotations']()}>
		<header class="space-y-3 border-b border-[var(--shell-border)] p-4">
			<div class="flex items-center justify-between">
				<h2 class="font-semibold">{m['pv4.annotations']()} <span class="text-sm">({panel.counts.all})</span></h2>
				<button type="button" aria-label={m['pv10.close']()} onclick={close}><Icon name="x" /></button>
			</div>
			<div class="flex flex-wrap gap-1" role="group" aria-label={m['pv10.kind_filter']()}>
				{#each PANEL_FILTERS as kind (kind)}
					<button type="button" class="rounded border px-2 py-1 text-xs aria-pressed:bg-emerald-800 aria-pressed:text-white" aria-pressed={filter === kind} onclick={() => { if (canDiscard()) filter = kind; }}>{labels[kind]()} ({panel.counts[kind]})</button>
				{/each}
			</div>
			<input type="search" class="w-full rounded border p-2 text-sm" aria-label={m['pv10.search']()} placeholder={m['pv10.search']()} value={query} oninput={(event) => { if (canDiscard()) query = event.currentTarget.value; else event.currentTarget.value = query; }} />
		</header>
		{#if controller.actionError || controller.pendingError}
			<div role="alert" class="border-b border-[var(--shell-border)] p-3 text-sm">
				<p>{controller.actionError || controller.pendingError}</p>
				{#if controller.pendingError}
					<button type="button" class="mt-1 underline" onclick={() => controller.retryWrites()}>{m['reader.retry_saves']()}</button>
				{/if}
			</div>
		{/if}
		<div class="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
			{#if !groups.length}<p class="text-sm opacity-75">{panel.counts.all ? m['bv9.no_match']() : m['pv10.empty']()}</p>{/if}
			{#each groups as group (group.page)}
				<section aria-label={m['pv10.page']({ page: group.page })}>
					<h3 class="mb-2 text-sm font-semibold">{m['pv10.page']({ page: group.page })}</h3>
					<ul class="space-y-2">
						{#each group.entries as entry (`${entry.kind}:${entry.id}`)}
							<PanelEntry {entry} {controller} onjump={jump} ondelete={remove} ondeleteNote={removeNote} {registerGuard} />
						{/each}
					</ul>
				</section>
			{/each}
			{#if other.length}
				<details>
					<summary class="text-sm font-semibold">{m['reader.annotations.other_file']()} ({other.length})</summary>
					<ul class="mt-2 space-y-2">
						{#each other as entry (`${entry.kind}:${entry.id}`)}
							<PanelEntry {entry} {controller} onjump={jump} ondelete={remove} ondeleteNote={removeNote} {registerGuard} readonly />
						{/each}
					</ul>
				</details>
			{/if}
			<section aria-labelledby="pv10-book-notes">
				<h3 id="pv10-book-notes" class="mb-2 text-sm font-semibold">{m['reader.annotations.book_notes']()}</h3>
				<BookNotes notes={panel.bookNotes} {controller} {registerGuard} ondelete={removeNote} />
			</section>
		</div>
		{#if undo}
			<div role="status" class="flex items-center justify-between border-t border-[var(--shell-border)] p-3 text-sm">
				{m['pv10.deleted']()}
				<button type="button" class="underline" disabled={controller.busy} onclick={restore}>{m['pv10.undo']()}</button>
			</div>
		{/if}
	</aside>
{/if}

<style>
	.pv10-panel :global(button), .pv10-panel :global(input), .pv10-panel :global(textarea) { outline-offset: 3px; }
	.pv10-panel :global(input), .pv10-panel :global(textarea) { background: var(--shell-surface); color: var(--shell-text); border-color: var(--shell-border); }
	.pv10-panel :global(.reader-note-editor), .pv10-panel :global(.reader-note-preview) { background: var(--shell-surface); color: var(--shell-text); border-color: var(--shell-border); }
	.pv10-panel :global(button:disabled) { opacity: 0.5; }
	@media (max-width: 640px) { .pv10-panel { width: 100%; max-width: 100%; } }
</style>
