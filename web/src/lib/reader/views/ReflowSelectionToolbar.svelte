<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { FoliateReader } from '../foliate.js';
	import type { ReaderController } from '../session/reader-controller.svelte.js';
	import type { HighlightStyle, ReaderSelection } from '../types.js';
	import type { MarkColor } from '../annotations.js';
	import SelectionToolbar from '../pdf/marks/SelectionToolbar.svelte';
	import { intersects, type RectLike } from '../pdf/marks/floating.js';
	import { markColors } from '../pdf/marks/mark-colors.svelte.js';
	import '../pdf/marks/marks.css';

	let { engine, controller, surface, cancomment, oncomment, onclear, onerror }: {
		engine: FoliateReader;
		controller: ReaderController;
		surface: HTMLElement;
		cancomment: () => boolean;
		oncomment: (highlightId: string) => void;
		onclear: () => void;
		onerror: (message: string) => void;
	} = $props();

	let host = $state<HTMLDivElement>();
	let chosen = $state.raw<ReaderSelection | null>(null);
	let anchor = $state<RectLike | null>(null);
	let bounds = $state<RectLike>({ left: 0, top: 0, right: 0, bottom: 0 });
	let working = $state(false);
	let status = $state('');
	let dismissedSelection: ReaderSelection | null = null;
	const busy = $derived(working || controller.busy);
	const toolbarFocused = () => !!host?.contains(document.activeElement);

	function dismiss(clear = false) {
		const focus = toolbarFocused();
		dismissedSelection = controller.selection;
		chosen = null;
		anchor = null;
		if (clear) {
			onclear();
			engine.clearSelection();
		}
		if (focus) surface.focus({ preventScroll: true });
	}

	$effect(() => {
		if (markColors.storageError) onerror(m['pv5.preference_error']());
	});

	$effect(() => {
		const reader = engine;
		const viewport = surface;
		let frame = 0;
		let disposed = false;
		const refresh = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (disposed) return;
				bounds = viewport.getBoundingClientRect();
				const rect = reader.getSelectionBounds();
				if (!rect) {
					// Palette focus can collapse an iframe's native selection. Keep the captured CFI
					// only while focus is in this toolbar, never merely because the controller kept it.
					if (!toolbarFocused()) dismiss();
					return;
				}
				const active = document.activeElement;
				if (active && active !== document.body && !viewport.contains(active) && !toolbarFocused()) {
					dismiss();
					return;
				}
				if (!intersects(rect, bounds) || !controller.selection) {
					dismiss();
					return;
				}
				if (dismissedSelection === controller.selection) return;
				chosen = controller.selection;
				anchor = rect;
			});
		};
		const outside = (event: Event) => {
			if (event.composedPath().includes(host!)) return;
			if (!event.composedPath().includes(viewport)) dismiss();
		};
		const keydown = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight')
				&& !event.defaultPrevented && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
				&& !target?.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target?.tagName ?? '')
				&& !toolbarFocused()) onclear();
			if (!chosen || event.defaultPrevented) return;
			if (event.key === 'Escape') {
				event.preventDefault();
				dismiss(true);
			} else if (event.key === 'Tab' && !event.shiftKey && !toolbarFocused()) {
				event.preventDefault();
				host?.querySelector<HTMLButtonElement>('[data-roving]')?.focus({ preventScroll: true });
			}
		};
		const unsubscribe = reader.subscribeSelection((reason) => {
			if (reason === 'geometry' && !reader.getSelectionBounds()) dismiss();
			refresh();
		});
		const unsubscribeKeyboard = reader.subscribeSelectionKeyboard(keydown);
		// Scroll/resize must also dismiss a pinned palette if the text no longer has live bounds.
		const geometry = () => {
			if (!reader.getSelectionBounds()) dismiss();
			refresh();
		};
		const observer = new ResizeObserver(geometry);
		observer.observe(viewport);
		window.addEventListener('resize', geometry);
		window.addEventListener('scroll', geometry, true);
		document.addEventListener('pointerdown', outside, true);
		document.addEventListener('focusin', outside);
		document.addEventListener('keydown', keydown);
		refresh();
		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			unsubscribe();
			unsubscribeKeyboard();
			observer.disconnect();
			window.removeEventListener('resize', geometry);
			window.removeEventListener('scroll', geometry, true);
			document.removeEventListener('pointerdown', outside, true);
			document.removeEventListener('focusin', outside);
			document.removeEventListener('keydown', keydown);
		};
	});

	async function run(action: () => Promise<void>, failure = m['reader.error.save']()) {
		if (busy) return;
		working = true;
		status = '';
		onerror('');
		try {
			await action();
		} catch (error) {
			console.error('Reflow selection action failed', error);
			onerror(failure);
		} finally {
			working = false;
		}
	}

	function mark(style: HighlightStyle, color = markColors.get(style), comment = false) {
		const selection = chosen;
		if (!selection || (comment && !cancomment())) return;
		void run(async () => {
			const created = await controller.addHighlight(selection, color, style);
			if (!created) return;
			dismiss(true);
			status = m['pv8.marked']();
			if (comment) {
				oncomment(created.id);
			}
		});
	}

	function bookmark() {
		const selection = chosen;
		if (!selection) return;
		void run(async () => {
			const saved = await controller.addBookmark({
				label: selection.text.replace(/\s+/g, ' ').trim().slice(0, 80),
				at: selection
			});
			if (saved) {
				dismiss(true);
				status = m['ux6.saved']();
			}
		});
	}

	function copy() {
		const selection = chosen;
		if (!selection) return;
		void run(async () => {
			let copied = false;
			try {
				await navigator.clipboard.writeText(selection.text);
				copied = true;
			} catch {
				const area = document.createElement('textarea');
				area.value = selection.text;
				area.readOnly = true;
				area.style.cssText = 'position:fixed;opacity:0;left:0;top:0';
				const active = document.activeElement as HTMLElement | null;
				document.body.append(area);
				area.select();
				try {
					copied = document.execCommand('copy');
				} finally {
					area.remove();
					active?.focus({ preventScroll: true });
				}
			}
			if (!copied) throw new Error('The clipboard rejected the selected text.');
			status = m['pv8.copied']();
		}, m['pv8.copy_failed']());
	}
</script>

<div bind:this={host} class="reflow-selection-toolbar">
	{#if chosen && anchor}
		<SelectionToolbar {anchor} {bounds} highlightColor={markColors.get('highlight')} lineColor={markColors.get('underline')}
			disabled={busy} oncopy={copy} onmark={mark} oncomment={() => mark('highlight', markColors.get('highlight'), true)}
			onbookmark={bookmark} onpick={(style, color: MarkColor) => {
				markColors.set(style, color);
				if (style === 'highlight') mark(style, color);
			}}
			onescape={() => dismiss(true)} />
	{/if}
	<p class="sr-only" role="status">{status}</p>
</div>

<style>
	.reflow-selection-toolbar { display: contents; }
</style>
