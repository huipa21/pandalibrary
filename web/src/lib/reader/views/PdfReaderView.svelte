<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { readerChrome } from '#lib/shell/reader-chrome.js';
	import ReaderFrame from '#lib/reader/frame/ReaderFrame.svelte';
	import ReaderCloseButton from '#lib/reader/frame/ReaderCloseButton.svelte';
	import ReaderStatusDot from '#lib/reader/frame/ReaderStatusDot.svelte';
	import ReaderToolbar from '#lib/reader/toolbar/ReaderToolbar.svelte';
	import PageCounter from '#lib/reader/toolbar/PageCounter.svelte';
	import ProgressLabel from '#lib/reader/toolbar/ProgressLabel.svelte';
	import ZoomMenu from '#lib/reader/toolbar/ZoomMenu.svelte';
	import LayoutMenu from '#lib/reader/toolbar/LayoutMenu.svelte';
	import RotateMenu from '#lib/reader/toolbar/RotateMenu.svelte';
	import ToolToggle from '#lib/reader/toolbar/ToolToggle.svelte';
	import InsertToggle from '#lib/reader/toolbar/InsertToggle.svelte';
	import type { PdfReader } from '#lib/reader/pdf.js';
	import type { ReaderController } from '#lib/reader/session/reader-controller.svelte.js';
	import type { PdfLayout, PdfViewState, PdfZoom, ReaderSettings } from '#lib/reader/types.js';
	import { PDF_TOOL_KEY, storedTool, toolShortcut, viewSettings, viewSettingsChanged, type PdfTool } from './pdf-view-state.js';

	const SAVE_DELAY = 1000;
	let { controller }: { controller: ReaderController } = $props();
	let surface = $state<HTMLDivElement>();
	let engine = $state<PdfReader | null>(null);
	let view = $state<PdfViewState | null>(null);
	let tool = $state<PdfTool>('select');
	let previousTool: 'select' | 'hand' = 'select';
	let panning: { id: number; x: number; y: number; left: number; top: number } | null = null;
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	// The "Saved" status of view-state autosaves is not shown; explicit saves still report.
	let autosavedMessage = $state('');

	const page = $derived(view?.page ?? (controller.location?.locator.type === 'pdf' ? controller.location.locator.page : 1));
	const savedMessage = $derived(controller.savedMessage === autosavedMessage ? '' : controller.savedMessage);

	/** Engine view fields override the controller's copy, which may lag behind wheel/keyboard zoom. */
	function currentSettings(): Partial<ReaderSettings> {
		return view ? viewSettings(view) : {};
	}

	function scheduleSave() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => void persist(), SAVE_DELAY);
	}

	async function persist() {
		saveTimer = undefined;
		if (!view || !controller.canSaveSettings) return;
		if (controller.busy) {
			scheduleSave();
			return;
		}
		await controller.saveSettings(currentSettings());
		autosavedMessage = controller.savedMessage;
	}

	function onView(state: PdfViewState) {
		view = state;
		if (viewSettingsChanged(controller.settings, state)) scheduleSave();
	}

	function run(action: Promise<void> | undefined) {
		void action?.catch((error) => console.error('Could not change the PDF view', error));
	}

	function setTheme(theme: ReaderSettings['theme']) {
		run(controller.applySettings({ ...currentSettings(), theme }));
		scheduleSave();
	}

	function jump(next: number) {
		run(engine?.goTo({ type: 'pdf', page: next }));
	}

	function setTool(next: PdfTool) {
		if (next === tool) return;
		if (next !== 'insert') {
			previousTool = next;
			localStorage.setItem(PDF_TOOL_KEY, next);
		} else if (tool !== 'insert') previousTool = tool;
		if (next !== 'select') document.getSelection()?.removeAllRanges();
		tool = next;
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.defaultPrevented || !engine) return;
		if (event.key === 'Escape' && tool === 'insert') {
			event.preventDefault();
			setTool(previousTool);
			return;
		}
		const next = toolShortcut(event, event.target);
		if (next) {
			event.preventDefault();
			setTool(next === tool && next === 'insert' ? previousTool : next);
		}
	}

	function startPan(event: PointerEvent) {
		if (tool !== 'hand' || event.button !== 0 || !surface) return;
		panning = { id: event.pointerId, x: event.clientX, y: event.clientY, left: surface.scrollLeft, top: surface.scrollTop };
		surface.setPointerCapture(event.pointerId);
		surface.classList.add('pv-panning');
		event.preventDefault();
	}

	function pan(event: PointerEvent) {
		if (!panning || panning.id !== event.pointerId || !surface) return;
		surface.scrollLeft = panning.left - (event.clientX - panning.x);
		surface.scrollTop = panning.top - (event.clientY - panning.y);
	}

	function endPan(event: PointerEvent) {
		if (!panning || panning.id !== event.pointerId) return;
		panning = null;
		surface?.classList.remove('pv-panning');
	}

	onMount(() => {
		if (!surface) throw new Error('The reader surface is unavailable.');
		tool = storedTool(localStorage.getItem(PDF_TOOL_KEY));
		previousTool = tool === 'hand' ? 'hand' : 'select';
		readerChrome.set('full');
		let destroyed = false;
		let unsubscribe: (() => void) | undefined;
		void controller.attach(surface).then((reader) => {
			if (destroyed) return;
			engine = reader as PdfReader;
			unsubscribe = engine.subscribeView(onView);
		}).catch((error) => {
			console.error('Could not open the PDF reader view', error);
			if (!destroyed) readerChrome.set('default');
		});
		return () => {
			destroyed = true;
			unsubscribe?.();
			if (saveTimer !== undefined) {
				clearTimeout(saveTimer);
				void persist();
			}
			readerChrome.set('default');
		};
	});
</script>

<svelte:window onkeydown={onKeydown} />

<ReaderFrame title={controller.book?.title ?? m['common.app_name']()}>
	{#snippet toolbar()}
		<ReaderToolbar>
			{#snippet left()}
				<PageCounter {page} pageCount={view?.pageCount ?? 0} disabled={!engine} onjump={jump} />
				<ProgressLabel fraction={controller.location?.fraction ?? 0} />
			{/snippet}
			{#snippet status()}<ReaderStatusDot />{/snippet}
			{#snippet centre()}<h1 class="pv-title">{controller.book?.title}</h1>{/snippet}
			{#snippet overflow()}
				<ZoomMenu
					zoom={view?.zoom ?? controller.settings.pdfZoom ?? 'page-width'}
					scale={view?.scale ?? 1}
					onzoom={(zoom: PdfZoom) => run(engine?.setZoom(zoom))}
					onstep={(step) => run(engine?.zoomBy(step))}
				/>
				<LayoutMenu
					layout={view?.layout ?? controller.settings.pdfLayout ?? 'single'}
					coverAlone={view?.coverAlone ?? controller.settings.pdfCoverAlone ?? false}
					theme={controller.settings.theme}
					onlayout={(layout: PdfLayout) => run(engine?.setLayout(layout))}
					oncoveralone={(alone) => run(engine?.setCoverAlone(alone))}
					ontheme={setTheme}
				/>
				<RotateMenu onrotate={(delta) => run(engine?.rotate(delta))} />
			{/snippet}
			{#snippet right()}
				<ToolToggle tool={tool === 'hand' ? 'hand' : 'select'} ontoggle={() => setTool(tool === 'hand' ? 'select' : 'hand')} />
				<InsertToggle active={tool === 'insert'} disabled={!engine} ontoggle={() => setTool(tool === 'insert' ? previousTool : 'insert')} />
				<span class="pv-divider" aria-hidden="true"></span>
				<ReaderCloseButton closing={controller.closing} onclose={() => controller.close()} />
			{/snippet}
		</ReaderToolbar>
	{/snippet}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex: the book surface must be keyboard-scrollable -->
	<div
		bind:this={surface}
		id="reader-surface"
		role="region"
		aria-label={m['reader.surface']()}
		tabindex="0"
		data-tool={tool}
		class="absolute inset-0 overflow-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-500"
		onpointerdown={startPan}
		onpointermove={pan}
		onpointerup={endPan}
		onpointercancel={endPan}
	></div>
	{#if controller.pendingError || controller.actionError || controller.opening || savedMessage}
		<div class="absolute inset-x-2 top-2 z-20 max-h-[50%] overflow-auto rounded-md bg-[var(--pv-chrome)] p-3 text-sm shadow-md">
			{#if controller.pendingError}
				<div role="alert" class="space-y-2">
					<p>{controller.pendingError}</p>
					<button class="underline focus-visible:outline-2" onclick={() => controller.retryWrites()}>{m['reader.retry_saves']()}</button>
					<a class="ml-4 underline focus-visible:outline-2" href={`/books/${controller.book?.id}`}>{m['reader.leave_unsaved']()}</a>
				</div>
			{/if}
			{#if controller.actionError}<p role="alert">{controller.actionError}</p>{/if}
			{#if controller.opening}<p role="status">{m['reader.loading']()}</p>{/if}
			{#if savedMessage}<p role="status">{savedMessage}</p>{/if}
		</div>
	{/if}
</ReaderFrame>

<style>
	.pv-title { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 400; }
	.pv-divider { width: 1px; height: 20px; margin: 0 2px; background: var(--shell-border, #94a3b8); flex: none; }
	[data-tool='hand'], [data-tool='hand'] :global(*) { cursor: grab; user-select: none; }
	:global(.pv-panning), :global(.pv-panning *) { cursor: grabbing !important; }
	[data-tool='insert'], [data-tool='insert'] :global(*) { cursor: crosshair; user-select: none; }
</style>
