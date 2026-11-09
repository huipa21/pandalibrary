<script lang="ts">
	import { onMount } from 'svelte';
	import { v7 as uuidv7 } from 'uuid';
	import * as m from '#lib/paraglide/messages.js';
	import { HIGHLIGHT_COLORS, type HighlightColor } from '../../annotations.js';
	import type { Highlight, HighlightStyle, ReaderSelection } from '../../types.js';
	import { getPdfReaderContext } from '../context.js';
	import { toFraction } from '../progress.js';
	import OcrStatusChip from '../ocr/OcrStatusChip.svelte';
	import type { OcrStatus } from '../ocr/status.js';
	import { intersects, unionRect, type RectLike } from './floating.js';
	import { capturePdfSelection, type PdfSelection, type PdfSelectionPart } from './selection.js';
	import { changedPages, textMarkPainter, textMarks } from './text-mark-painter.js';
	import { wireOcr, type OcrWiring } from './ocr-wiring.js';
	import SelectionToolbar from './SelectionToolbar.svelte';
	import MarkToolbar from './MarkToolbar.svelte';
	import CommentPopover from './CommentPopover.svelte';
	import './marks.css';

	const COLOR_KEY = 'pandalibrary.pdf-mark-color';
	const ctx = getPdfReaderContext();
	const { engine, controller } = ctx;

	interface CommentTarget {
		highlightId: string;
		noteId: string;
		initial: string;
		editing: boolean;
		/** Marks created by the Comment action; removed again when it is cancelled empty. */
		created: Highlight[];
		anchor: RectLike;
	}

	let bounds = $state<RectLike>({ left: 0, top: 0, right: 0, bottom: 0 });
	let selection = $state.raw<PdfSelection | null>(null);
	let markTarget = $state<{ id: string; anchor: RectLike } | null>(null);
	let comment = $state<CommentTarget | null>(null);
	let toast = $state<{ message: string; undo: () => void } | null>(null);
	let working = $state(false);
	let ocrStatus = $state<OcrStatus>({ state: 'idle' });
	let wiring = $state.raw<OcrWiring | null>(null);

	const marks = $derived(textMarks(controller.highlights, controller.notes, controller.file?.id));
	const markRow = $derived(markTarget ? controller.highlights.find((row) => row.id === markTarget!.id && !row.deleted_at) ?? null : null);
	const busy = $derived(working || controller.busy);
	const liveNote = (highlightId: string) =>
		controller.notes.find((note) => note.highlight_id === highlightId && !note.deleted_at && note.body_md.trim());

	let signatures = new Map<string, string>();
	$effect(() => {
		const { pages, signatures: next } = changedPages(signatures, marks);
		signatures = next;
		for (const page of pages) engine.pageLayers.repaint(page);
	});

	$effect(() => {
		const tool = ctx.tool.current;
		wiring?.update(ctx.ocr.enabled, tool);
		if (tool !== 'select') selection = null;
		if (tool === 'insert') markTarget = null;
	});

	$effect(() => {
		if (markTarget && !markRow) markTarget = null;
	});

	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	async function idle() {
		while (controller.busy) await sleep(25);
	}

	function clientRect(element: Element): RectLike {
		const { left, top, right, bottom } = element.getBoundingClientRect();
		return { left, top, right, bottom };
	}

	function markAnchor(id: string): RectLike | null {
		return unionRect([...engine.viewport.querySelectorAll(`.reader-pdf-highlight[data-annotation-id="${CSS.escape(id)}"]`)].map(clientRect));
	}

	function capture() {
		if (ctx.tool.current !== 'select') {
			selection = null;
			return;
		}
		const next = capturePdfSelection(document.getSelection(), engine);
		selection = next;
		if (next) markTarget = null;
	}

	let captureTimer: ReturnType<typeof setTimeout> | undefined;
	function scheduleCapture() {
		clearTimeout(captureTimer);
		captureTimer = setTimeout(capture, 120);
	}

	let frame = 0;
	function refresh() {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(() => {
			bounds = clientRect(engine.viewport);
			if (selection) capture();
			if (markTarget) {
				const anchor = markAnchor(markTarget.id);
				if (anchor) markTarget.anchor = anchor;
			}
			if (comment) {
				const anchor = markAnchor(comment.highlightId);
				if (anchor) comment.anchor = anchor;
			}
		});
	}

	function focusViewport() {
		engine.viewport.focus({ preventScroll: true });
	}

	function clearSelection() {
		const active = document.activeElement;
		document.getSelection()?.removeAllRanges();
		selection = null;
		if (!active || active === document.body || active.closest('.pv8-toolbar')) focusViewport();
	}

	function readerSelection(part: PdfSelectionPart): ReaderSelection {
		const offset = Math.min(...part.rects.map((rect) => rect.y));
		return {
			text: part.text,
			fraction: toFraction(part.page, offset, engine.state.pageCount),
			locator: { type: 'pdf', page: part.page, rects: part.rects }
		};
	}

	/** One row per page part, sequentially; earlier rows are removed again when a later one fails. */
	async function createMarks(chosen: PdfSelection, color: HighlightColor, style: HighlightStyle): Promise<Highlight[] | null> {
		const created: Highlight[] = [];
		for (const part of chosen.parts) {
			await idle();
			const row = await controller.addHighlight(readerSelection(part), color, style);
			if (!row) {
				for (const done of created.reverse()) {
					await idle();
					await controller.removeHighlight(done, { confirm: false });
				}
				return null;
			}
			created.push(row);
		}
		return created;
	}

	async function run(action: () => Promise<void>) {
		if (working) return;
		working = true;
		try {
			await action();
		} catch (error) {
			console.error('PDF mark action failed', error);
		} finally {
			working = false;
		}
	}

	async function copyText(text: string) {
		let copied = false;
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
		} catch {
			const area = document.createElement('textarea');
			area.value = text;
			area.setAttribute('readonly', '');
			Object.assign(area.style, { position: 'fixed', top: '0', left: '0', opacity: '0' });
			const active = document.activeElement as HTMLElement | null;
			document.body.append(area);
			area.select();
			try {
				copied = document.execCommand('copy');
			} catch {
				copied = false;
			}
			area.remove();
			active?.focus({ preventScroll: true });
		}
		ctx.announce(copied ? m['pv8.copied']() : m['pv8.copy_failed']());
	}

	function pickColor(color: HighlightColor) {
		ctx.markColor.set(color);
		try {
			localStorage.setItem(COLOR_KEY, color);
		} catch {
			// Storage can be unavailable (private mode); the colour still applies for this session.
		}
	}

	function mark(style: HighlightStyle, color = ctx.markColor.current) {
		const chosen = selection;
		if (!chosen) return;
		void run(async () => {
			const created = await createMarks(chosen, color, style);
			if (!created) return;
			clearSelection();
			ctx.announce(m['pv8.marked']());
		});
	}

	function commentOnSelection() {
		const chosen = selection;
		if (!chosen) return;
		void run(async () => {
			const created = await createMarks(chosen, ctx.markColor.current, 'highlight');
			if (!created) return;
			clearSelection();
			comment = {
				highlightId: created[0].id, noteId: uuidv7(), initial: '', editing: false, created,
				anchor: markAnchor(created[0].id) ?? chosen.anchor
			};
		});
	}

	function bookmarkSelection() {
		const chosen = selection;
		if (!chosen) return;
		const first = chosen.parts[0];
		void run(async () => {
			await idle();
			const saved = await controller.addBookmark({ label: chosen.text.replace(/\s+/g, ' ').trim().slice(0, 80), at: readerSelection(first) });
			if (!saved) return;
			clearSelection();
			ctx.announce(m['pv8.bookmarked']({ page: first.page }));
		});
	}

	function openComment(highlightId: string, anchor: RectLike) {
		const note = liveNote(highlightId);
		markTarget = null;
		comment = { highlightId, noteId: note?.id ?? uuidv7(), initial: note?.body_md ?? '', editing: !!note, created: [], anchor };
	}

	function saveComment(body: string) {
		const target = comment;
		if (!target) return;
		void run(async () => {
			await idle();
			const saved = await controller.saveNote({
				id: target.noteId, highlightId: target.highlightId, body, original: target.initial, editing: target.editing
			});
			if (!saved) return;
			comment = null;
			ctx.announce(m['pv8.comment_saved']());
			focusViewport();
		});
	}

	function cancelComment(body: string) {
		const target = comment;
		comment = null;
		focusViewport();
		if (!target || !target.created.length || body.trim()) return;
		void run(async () => {
			for (const row of [...target.created].reverse()) {
				await idle();
				await controller.removeHighlight(row, { confirm: false });
			}
		});
	}

	let toastTimer: ReturnType<typeof setTimeout> | undefined;
	function showToast(message: string, undo: () => void) {
		clearTimeout(toastTimer);
		toast = { message, undo };
		ctx.announce(message);
		toastTimer = setTimeout(() => { toast = null; }, 6000);
	}

	function deleteMark(row: Highlight) {
		const notes = controller.notes.filter((note) => note.highlight_id === row.id && !note.deleted_at);
		void run(async () => {
			await idle();
			if (!await controller.removeHighlight(row, { confirm: false })) return;
			markTarget = null;
			focusViewport();
			showToast(m['pv8.deleted'](), () => {
				clearTimeout(toastTimer);
				toast = null;
				void run(async () => {
					await idle();
					if (await controller.restoreDeletedAnnotation({ kind: 'mark', row, notes })) ctx.announce(m['pv8.restored']());
				});
			});
		});
	}

	function changeMark(row: Highlight, patch: { color?: HighlightColor; style?: HighlightStyle }) {
		void run(async () => {
			await idle();
			await controller.updateHighlight(row, patch);
		});
	}

	onMount(() => {
		try {
			const stored = localStorage.getItem(COLOR_KEY);
			if (stored && (HIGHLIGHT_COLORS as readonly string[]).includes(stored)) ctx.markColor.set(stored as HighlightColor);
		} catch {
			// Ignore unavailable storage.
		}
		const viewport = engine.viewport;
		bounds = clientRect(viewport);
		const unregister = engine.pageLayers.register(textMarkPainter(() => marks, () => m['pv8.open_comment']()));
		engine.setSelectionCapture(scheduleCapture);
		const unsubscribe = engine.subscribe(refresh);
		wiring = wireOcr(ctx, (status) => { ocrStatus = status; });
		ctx.setToolbarStatus('ocr', ocrChip);

		let down: { x: number; y: number } | null = null;
		const onpointerdown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; };
		const onclick = (event: MouseEvent) => {
			const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.reader-pdf-highlight, .pv-mark-comment') : null;
			const moved = down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4;
			if (!target || moved || ctx.tool.current === 'insert') return;
			if (document.getSelection()?.isCollapsed === false) return;
			const id = target.dataset.annotationId!;
			const anchor = markAnchor(id) ?? clientRect(target);
			if (target.classList.contains('pv-mark-comment')) openComment(id, anchor);
			else {
				comment = null;
				markTarget = { id, anchor };
			}
		};
		const ondocumentdown = (event: PointerEvent) => {
			if (!markTarget || !(event.target instanceof Element)) return;
			if (event.target.closest('.pv8-floating, .reader-pdf-highlight, .pv-mark-comment')) return;
			markTarget = null;
		};
		const onresize = () => refresh();
		// pdf.js text layers are tab stops, so Tab from inside the viewport jumps straight to the open toolbar.
		const onkeydown = (event: KeyboardEvent) => {
			if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
			if (!selection || comment || !intersects(selection.anchor, bounds) || !(event.target instanceof Node) || !viewport.contains(event.target)) return;
			const item = document.querySelector<HTMLElement>('[data-testid="pv8-selection-toolbar"] [data-roving][tabindex="0"]')
				?? document.querySelector<HTMLElement>('[data-testid="pv8-selection-toolbar"] [data-roving]');
			if (!item) return;
			event.preventDefault();
			item.focus();
		};
		viewport.addEventListener('keydown', onkeydown);
		viewport.addEventListener('pointerdown', onpointerdown);
		viewport.addEventListener('click', onclick);
		viewport.addEventListener('scroll', refresh, { passive: true });
		document.addEventListener('pointerup', scheduleCapture);
		document.addEventListener('keyup', scheduleCapture);
		document.addEventListener('pointerdown', ondocumentdown, true);
		window.addEventListener('resize', onresize);
		return () => {
			clearTimeout(captureTimer);
			clearTimeout(toastTimer);
			cancelAnimationFrame(frame);
			viewport.removeEventListener('keydown', onkeydown);
			viewport.removeEventListener('pointerdown', onpointerdown);
			viewport.removeEventListener('click', onclick);
			viewport.removeEventListener('scroll', refresh);
			document.removeEventListener('pointerup', scheduleCapture);
			document.removeEventListener('keyup', scheduleCapture);
			document.removeEventListener('pointerdown', ondocumentdown, true);
			window.removeEventListener('resize', onresize);
			engine.setSelectionCapture(null);
			unsubscribe();
			unregister();
			wiring?.dispose();
			wiring = null;
			ctx.setToolbarStatus('ocr', null);
		};
	});
</script>

{#snippet ocrChip()}<OcrStatusChip status={ocrStatus} />{/snippet}

{#if selection && !comment}
	<SelectionToolbar
		anchor={selection.anchor}
		{bounds}
		hidden={!intersects(selection.anchor, bounds)}
		color={ctx.markColor.current}
		disabled={busy}
		oncopy={() => { if (selection) void copyText(selection.text); }}
		onmark={(style) => mark(style)}
		oncomment={commentOnSelection}
		onbookmark={bookmarkSelection}
		onpick={(color) => { pickColor(color); mark('highlight', color); }}
		onescape={clearSelection}
	/>
{/if}

{#if markTarget && markRow && !comment}
	{@const row = markRow}
	{#key row.id}
		<MarkToolbar
			mark={row}
			anchor={markTarget.anchor}
			{bounds}
			hasNote={!!liveNote(row.id)}
			disabled={busy}
			oncolor={(color) => changeMark(row, { color })}
			onstyle={(style) => changeMark(row, { style })}
			oncomment={() => { if (markTarget) openComment(row.id, markTarget.anchor); }}
			oncopy={() => void copyText(row.text)}
			ondelete={() => deleteMark(row)}
			onclose={() => { markTarget = null; focusViewport(); }}
		/>
	{/key}
{/if}

{#if comment}
	{#key comment.noteId}
		<CommentPopover
			anchor={comment.anchor}
			{bounds}
			initial={comment.initial}
			disabled={busy}
			onsave={saveComment}
			oncancel={cancelComment}
		/>
	{/key}
{/if}

{#if toast}
	<div class="pv8-toast" role="status" data-testid="pv8-toast">
		<span>{toast.message}</span>
		<button type="button" onclick={toast.undo}>{m['pv8.undo']()}</button>
	</div>
{/if}
