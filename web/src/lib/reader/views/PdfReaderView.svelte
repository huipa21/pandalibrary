<script lang="ts">
	import { onMount, untrack, type Snippet } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import { readerChrome } from '#lib/shell/reader-chrome.js';
	import ReaderFrame from '#lib/reader/frame/ReaderFrame.svelte';
	import ReaderCloseButton from '#lib/reader/frame/ReaderCloseButton.svelte';
	import ReaderStatusDot from '#lib/reader/frame/ReaderStatusDot.svelte';
	import ReaderToolbar from '#lib/reader/toolbar/ReaderToolbar.svelte';
	import PageCounter from '#lib/reader/toolbar/PageCounter.svelte';
	import ProgressLabel from '#lib/reader/toolbar/ProgressLabel.svelte';
	import ZoomMenu from '#lib/reader/toolbar/ZoomMenu.svelte';
	import LayoutMenu from '#lib/reader/toolbar/LayoutMenu.svelte';
	import FormatMenu from '#lib/reader/toolbar/FormatMenu.svelte';
	import { backgroundFor, withBackground, type BackgroundId } from '#lib/reader/appearance.js';
	import '#lib/reader/pdf/appearance.css';
	import RotateMenu from '#lib/reader/toolbar/RotateMenu.svelte';
	import ToolToggle from '#lib/reader/toolbar/ToolToggle.svelte';
	import InsertMenu, { type InsertType } from '#lib/reader/toolbar/InsertMenu.svelte';
	import { PdfViewerEngine } from '#lib/reader/pdf/engine.js';
	import type { ReaderController } from '#lib/reader/session/reader-controller.svelte.js';
	import type { PdfLayout, PdfZoom, ReaderSettings } from '#lib/reader/types.js';
	import type { PdfViewState } from '#lib/reader/pdf/types.js';
	import { PDF_TOOL_KEY, storedTool, viewSettings, viewSettingsChanged, type PdfTool } from './pdf-view-state.js';
	import { setPdfReaderContext } from '#lib/reader/pdf/context.js';
	import { attachPdfGestures } from '#lib/reader/pdf/gestures.js';
	import { editableTarget, viewKey } from '#lib/reader/pdf/view-keys.js';
	import MarksLayer from '#lib/reader/pdf/marks/MarksLayer.svelte';
	import InsertLayer from '#lib/reader/pdf/insert/InsertLayer.svelte';
	import ReaderSidebar from '#lib/reader/pdf/sidebar/ReaderSidebar.svelte';
	import { createSidebarState, PANEL_WIDTH, RAIL_WIDTH } from '#lib/reader/pdf/sidebar/sidebar-state.svelte.js';
	import { offlineStatus } from '#lib/sync/client.js';
	import { defaultPdfBookmarkLabel, pageBookmark } from '#lib/reader/pdf/sidebar/bookmarks/bookmarks-model.js';
	import { toFraction } from '#lib/reader/pdf/progress.js';
	import { capturePdfSelection } from '#lib/reader/pdf/marks/selection.js';

	const SAVE_DELAY = 1000;
	const OCR_KEY = 'pandalibrary.pdf-ocr';
	let { controller }: { controller: ReaderController } = $props();
	let surface = $state<HTMLDivElement>();
	let engine = $state<PdfViewerEngine | null>(null);
	let view = $state<PdfViewState | null>(null);
	let tool = $state<PdfTool>('select');
	let previousTool = $state<'select' | 'hand'>('select');
	let insertMenuOpen = $state(false);
	const sidebar = createSidebarState();
	let ocrEnabled = $state(true);
	let announcement = $state('');
	let statuses = $state<Record<string, Snippet>>({});
	let saving: Promise<void> | null = null;
	let dirty = false;
	let closingView = false;
	let boundBookId: number | undefined;
	let boundFileId: number | undefined;
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	// The "Saved" status of view-state autosaves is not shown; explicit saves still report.
	let autosavedMessage = $state('');
	let bookmarking = $state(false);

	const page = $derived(view?.page ?? (controller.location?.locator.type === 'pdf' ? controller.location.locator.page : 1));
	const background = $derived(backgroundFor(controller.settings));
	const savedMessage = $derived(controller.savedMessage === autosavedMessage ? '' : controller.savedMessage);
	const sidebarInset = $derived(RAIL_WIDTH + (sidebar.open && sidebar.docked ? PANEL_WIDTH : 0));
	const currentPageBookmark = $derived(pageBookmark(controller.bookmarks, controller.file?.id ?? -1, page));

	setPdfReaderContext({
		get engine() {
			if (!engine) throw new Error('The PDF engine is not ready.');
			return engine;
		},
		get controller() { return controller; },
		get view() {
			if (!view) throw new Error('The PDF view is not ready.');
			return view;
		},
		tool: { get current() { return tool; }, get previous() { return previousTool; }, set: setTool },
		get offline() { return !$offlineStatus.online; },
		get bookLanguage() { return controller.book?.language ?? null; },
		announce: (message) => { announcement = message; },
		sidebar,
		ocr: {
			get enabled() { return ocrEnabled; },
			set: setOcr
		},
		setToolbarStatus: (owner, content) => {
			const next = { ...statuses };
			if (content) next[owner] = content;
			else delete next[owner];
			statuses = next;
		}
	});

	function storePreference(key: string, value: string) {
		try {
			localStorage.setItem(key, value);
		} catch (error) {
			console.error('Could not save PDF tool preferences', error);
			announcement = m['pv5.preference_error']();
		}
	}

	function setOcr(enabled: boolean) {
		ocrEnabled = enabled;
		storePreference(OCR_KEY, String(enabled));
	}

	/** Engine view fields override the controller's copy, which may lag behind wheel/keyboard zoom. */
	function currentSettings(): ReaderSettings {
		return { ...controller.settings, ...(view ? viewSettings(view) : {}) };
	}

	function scheduleSave() {
		dirty = true;
		clearTimeout(saveTimer);
		if (!closingView) saveTimer = setTimeout(() => void persist(), SAVE_DELAY);
	}

	async function persist() {
		clearTimeout(saveTimer);
		saveTimer = undefined;
		if (saving) await saving;
		if (!dirty || !view || controller.book?.id !== boundBookId || controller.file?.id !== boundFileId) return;
		let saved = false;
		saving = (async () => {
			while (controller.busy) await new Promise((resolve) => setTimeout(resolve, 25));
			if (controller.book?.id !== boundBookId || controller.file?.id !== boundFileId) return;
			dirty = false;
			saved = await controller.saveSettings(currentSettings(), { scope: 'both' });
			if (!saved) dirty = true;
			autosavedMessage = controller.savedMessage;
		})();
		try { await saving; } finally { saving = null; }
		if (saved && dirty && closingView) await persist();
	}

	function onView(state: PdfViewState) {
		view = state;
		if (controller.ready && viewSettingsChanged(controller.settings, state)) scheduleSave();
	}

	function viewError(error: unknown) {
		console.error('Could not change the PDF view', error);
		announcement = m['reader.error.render']();
	}

	/** Engine view calls are mostly synchronous; navigation and settings are asynchronous. */
	function run(action: () => Promise<void> | void) {
		try {
			void action()?.catch(viewError);
		} catch (error) {
			viewError(error);
		}
	}

	function setBackground(id: BackgroundId) {
		run(() => controller.applySettings(withBackground(currentSettings(), id)));
		scheduleSave();
	}

	function jump(next: number) {
		run(() => engine?.goToPage(next));
	}

	async function togglePageBookmark() {
		if (bookmarking || controller.busy || !controller.ready || !engine?.pdf || !view || !controller.file) return;
		const active = engine;
		const fileId = controller.file.id;
		const bookId = controller.book?.id;
		const targetPage = page;
		const pageCount = view.pageCount;
		const existing = currentPageBookmark;
		const selected = capturePdfSelection(document.getSelection(), active);
		const selectedText = selected?.parts.find((part) => part.page === targetPage)?.text ?? '';
		bookmarking = true;
		try {
			if (existing) {
				await controller.removeBookmark(existing, { confirm: false });
				return;
			}
			let items: { str?: string; hasEOL?: boolean; transform?: number[] }[] = [];
			if (!selectedText.trim()) {
				try {
					const pdfPage = await active.pdf!.getPage(targetPage);
					items = (await pdfPage.getTextContent()).items.filter((item) => 'str' in item);
				} catch (error) {
					console.warn('Could not read the PDF bookmark label', error);
					const text = active.pageElement(targetPage)?.querySelector('.textLayer')?.textContent ?? '';
					items = [{ str: text.split(/\r?\n/).find((line) => line.trim()) ?? '' }];
				}
			}
			if (engine !== active || controller.book?.id !== bookId || controller.file?.id !== fileId || !controller.ready) return;
			await controller.addBookmark({
				label: defaultPdfBookmarkLabel(selectedText, items, m['rp8.page']({ page: targetPage })),
				at: { locator: { type: 'pdf', page: targetPage }, fraction: toFraction(targetPage, 0, pageCount) }
			});
		} finally {
			bookmarking = false;
		}
	}

	function setTool(next: PdfTool) {
		if (next === tool) return;
		if (next !== 'insert') {
			previousTool = next;
			storePreference(PDF_TOOL_KEY, next);
		} else if (tool !== 'insert') previousTool = tool;
		if (next !== 'select') document.getSelection()?.removeAllRanges();
		tool = next;
	}

	function startInsert(type: InsertType) {
		surface?.dispatchEvent(new CustomEvent('reader-start-insert', { detail: type }));
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.defaultPrevented || !engine) return;
		if (event.target instanceof Element && event.target.closest('.pv-sidebar')) return;
		const menuOpen = !!document.querySelector('[role="menu"], #reader-sync-status');
		if (event.target instanceof Element && event.target.closest('button, a, [role="dialog"]') && event.key !== 'Escape') return;
		const action = viewKey(event, editableTarget(event.target), menuOpen);
		if (!action) return;
		event.preventDefault();
		switch (action.type) {
			case 'turn': run(() => turn(action.direction)); break;
			case 'page': jump(action.end ? engine.state.pageCount : 1); break;
			case 'zoom': {
				const active = engine;
				run(() => action.direction ? active.zoomBy(action.direction) : active.setZoom('auto'));
				break;
			}
			case 'rotate': {
				const active = engine;
				run(() => active.rotate(action.delta));
				break;
			}
			case 'tool':
				if (action.tool === 'insert') insertMenuOpen = !insertMenuOpen;
				else setTool(action.tool);
				break;
			case 'escape':
				if (tool === 'insert') setTool(previousTool);
				else document.getSelection()?.removeAllRanges();
				break;
		}
	}

	async function turn(direction: -1 | 1) {
		if (!engine) return;
		const viewport = engine.viewport;
		if (engine.state.layout.endsWith('continuous')) viewport.scrollTop += direction * viewport.clientHeight;
		else await engine[direction === 1 ? 'next' : 'previous']();
	}

	let lastInset: number | undefined;
	let insetVersion = 0;
	$effect.pre(() => {
		const inset = sidebarInset;
		const active = untrack(() => engine);
		const changed = lastInset !== undefined && lastInset !== inset;
		lastInset = inset;
		if (!changed || !active) return;
		const { page, offset, zoom } = active.state;
		if (typeof zoom !== 'string') return;
		const version = ++insetVersion;
		const cancel = () => { if (version === insetVersion) insetVersion += 1; };
		const events = ['keydown', 'wheel', 'pointerdown', 'touchstart'] as const;
		for (const type of events) window.addEventListener(type, cancel, { capture: true, passive: true });
		const removeListeners = () => {
			for (const type of events) window.removeEventListener(type, cancel, { capture: true });
		};
		const settle = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200;
		const timer = setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => {
			removeListeners();
			if (version === insetVersion && engine === active) run(() => active.goToPage(page, offset));
		})), settle);
		return () => {
			clearTimeout(timer);
			removeListeners();
			cancel();
		};
	});

	function onSurfaceClick(event: MouseEvent) {
		const marker = event.target instanceof Element ? event.target.closest<HTMLElement>('.pv-mark-comment') : null;
		const id = marker?.dataset.annotationId;
		if (id && tool !== 'insert') sidebar.reveal('mark', id);
	}

	onMount(() => {
		if (!surface) throw new Error('The reader surface is unavailable.');
		boundBookId = controller.book?.id;
		boundFileId = controller.file?.id;
		try {
			tool = storedTool(localStorage.getItem(PDF_TOOL_KEY));
			ocrEnabled = localStorage.getItem(OCR_KEY) !== 'false';
		} catch (error) {
			console.error('Could not restore PDF tool preferences', error);
			announcement = m['pv5.preference_error']();
		}
		previousTool = tool === 'hand' ? 'hand' : 'select';
		readerChrome.set('full');
		let destroyed = false;
		let unsubscribe: (() => void) | undefined;
		let detachGestures: (() => void) | undefined;
		const element = surface;
		element.addEventListener('click', onSurfaceClick);
		controller.setViewSave(persist);
		void controller.attach(surface).then((reader) => {
			if (destroyed) return;
			if (!(reader instanceof PdfViewerEngine)) throw new Error('The attached reader does not support PDF view controls.');
			engine = reader;
			unsubscribe = reader.subscribe(onView);
			detachGestures = attachPdfGestures(reader, {
				tool: () => tool,
				turn,
				error: (error) => { console.error('Could not apply PDF gesture', error); announcement = m['reader.error.render'](); }
			});
		}).catch((error) => {
			console.error('Could not open the PDF reader view', error);
			if (!destroyed) readerChrome.set('default');
		});
		return () => {
			destroyed = true;
			closingView = true;
			insetVersion += 1;
			element.removeEventListener('click', onSurfaceClick);
			sidebar.dispose();
			unsubscribe?.();
			detachGestures?.();
			controller.setViewSave(async () => {});
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
				<ProgressLabel fraction={view?.fraction ?? controller.location?.fraction ?? 0} />
			{/snippet}
			{#snippet status()}
				<ReaderStatusDot warning={controller.settingsWarning} onretry={() => controller.retryWrites()} />
				{#each Object.keys(statuses).sort() as owner (owner)}{@render statuses[owner]()}{/each}
			{/snippet}
			{#snippet centre()}<h1 class="pv-title">{controller.book?.title}</h1>{/snippet}
			{#snippet overflow()}
				<ZoomMenu
					zoom={view?.zoom ?? controller.settings.pdfZoom ?? 'page-width'}
					scale={view?.scale ?? 1}
					onzoom={(zoom: PdfZoom) => run(() => engine?.setZoom(zoom))}
					onstep={(step) => run(() => engine?.zoomBy(step))}
				/>
				<LayoutMenu
					layout={view?.layout ?? controller.settings.pdfLayout ?? 'single-continuous'}
					{ocrEnabled}
					onlayout={(layout: PdfLayout) => run(() => engine?.setLayout(layout))}
					onocr={setOcr}
				/>
				<FormatMenu typography={false}
					font={controller.settings.font} size={controller.settings.size} spacing={controller.settings.spacing}
					background={background.id}
					onfont={(font) => run(() => controller.applySettings({ font }))}
					onsize={(size) => run(() => controller.applySettings({ size }))}
					onspacing={(spacing) => run(() => controller.applySettings({ spacing }))}
					onbackground={setBackground} />
				<RotateMenu onrotate={(delta) => run(() => engine?.rotate(delta))} />
			{/snippet}
			{#snippet right()}
				<button
					type="button" class="pv4-button" data-testid="pdf-bookmark-toggle"
					aria-label={m['rp8.add_page']()} aria-pressed={!!currentPageBookmark}
					title={currentPageBookmark ? m['rp8.remove_page']() : m['rp8.add_page']()}
					disabled={bookmarking || controller.busy || !controller.ready || !engine || !view}
					onpointerdown={(event) => event.preventDefault()} onclick={togglePageBookmark}
				><Icon name="bookmark" /></button>
				<ToolToggle tool={tool === 'hand' ? 'hand' : 'select'} ontoggle={() => setTool(tool === 'hand' ? 'select' : 'hand')} />
				<InsertMenu bind:open={insertMenuOpen} disabled={!engine} offline={!$offlineStatus.online} onselect={startInsert} />
				<span class="pv-divider" aria-hidden="true"></span>
				<ReaderCloseButton closing={controller.closing} onclose={() => controller.close()} />
			{/snippet}
		</ReaderToolbar>
	{/snippet}
	<ReaderSidebar ready={!!engine} />
	<div class="pv-page-area absolute inset-y-0 right-0" style:left="{sidebarInset}px">
		<!-- svelte-ignore a11y_no_noninteractive_tabindex: the book surface must be keyboard-scrollable -->
		<div
			bind:this={surface}
			id="reader-surface"
			role="region"
			aria-label={m['reader.surface']()}
			tabindex="0"
			data-tool={tool}
			data-background={background.id}
			data-tone={background.tone}
			class="absolute inset-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-500"
		></div>
		{#if engine}
			<MarksLayer />
			<InsertLayer />
		{/if}
	</div>
	<p class="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
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
	@media (prefers-reduced-motion: no-preference) {
		.pv-page-area { transition: left 150ms ease; }
	}
	[data-tool='hand'], [data-tool='hand'] :global(*) { cursor: grab; user-select: none; }
	:global(.pv-panning), :global(.pv-panning *) { cursor: grabbing !important; }
	[data-tool='insert'], [data-tool='insert'] :global(*) { cursor: crosshair; user-select: none; }
	[data-tool='hand'] :global(.textLayer span),
	[data-tool='insert'] :global(.textLayer span) { user-select: none; }
</style>
