<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { v7 as uuidv7 } from 'uuid';
	import * as m from '#lib/paraglide/messages.js';
	import { annotationForReader, highlightColor, HIGHLIGHT_COLORS, type HighlightColor } from '#lib/reader/annotations.js';
	import { bookmarkForPosition } from '#lib/reader/bookmarks.js';
	import { bookmarkExcerpt } from '#lib/reader/foliate-bookmarks.js';
	import StickyNote from '#lib/reader/StickyNote.svelte';
	import SearchField from '#lib/search/SearchField.svelte';
	import VirtualList from '#lib/reader/pdf/sidebar/annotations/VirtualList.svelte';
	import { buildAnnotationList, filterEntries, type AnnotationEntry } from '#lib/reader/pdf/sidebar/annotations/annotations-list.js';
	import { VIRTUAL_THRESHOLD } from '#lib/reader/pdf/sidebar/annotations/virtual-window.js';
	import '#lib/reader/pdf/sidebar/annotations/annotations.css';
	import SearchPanel from '#lib/reader/SearchPanel.svelte';
	import ReflowSelectionToolbar from './ReflowSelectionToolbar.svelte';
	import FormatMenu from '#lib/reader/toolbar/FormatMenu.svelte';
	import ReflowSizeMenu from '#lib/reader/toolbar/ReflowSizeMenu.svelte';
	import ReflowLayoutMenu from '#lib/reader/toolbar/ReflowLayoutMenu.svelte';
	import RotateMenu from '#lib/reader/toolbar/RotateMenu.svelte';
	import ToolbarMenu from '#lib/reader/toolbar/ToolbarMenu.svelte';
	import MenuItem from '#lib/reader/toolbar/MenuItem.svelte';
	import ReaderFrame from '#lib/reader/frame/ReaderFrame.svelte';
	import ReaderCloseButton from '#lib/reader/frame/ReaderCloseButton.svelte';
	import ReaderStatusDot from '#lib/reader/frame/ReaderStatusDot.svelte';
	import ReaderSidebar from '#lib/reader/frame/ReaderSidebar.svelte';
	import ReaderToolbar from '#lib/reader/toolbar/ReaderToolbar.svelte';
	import ProgressLabel from '#lib/reader/toolbar/ProgressLabel.svelte';
	import Icon from '#lib/bookview/Icon.svelte';
	import { readerChrome } from '#lib/shell/reader-chrome.js';
	import { FoliateReader } from '#lib/reader/foliate.js';
	import type { FoliateTocItem } from 'foliate-js/view.js';
	import { createSidebarState, PANEL_WIDTH, RAIL_WIDTH, type SidebarTab } from '#lib/reader/pdf/sidebar/sidebar-state.svelte.js';
	import { backgroundFor, withBackground } from '#lib/reader/appearance.js';
	import type { Bookmark, Note, ReaderSelection } from '#lib/reader/types.js';
	import type { ReaderController, NoteDraft, BookmarkDraft } from '#lib/reader/session/reader-controller.svelte.js';
	let { controller }: { controller: ReaderController } = $props();
	let surface = $state<HTMLDivElement>();
	let draft = $state<NoteDraft | null>(null);
	let stickyHost = $state<HTMLDivElement>();
	let createdCommentMark = $state<string | null>(null);
	let noteTrigger: HTMLElement | null = null;
	let detail = $state<{ id: string; readonly: boolean; trigger: HTMLButtonElement } | null>(null);
	let detailHost = $state<HTMLDivElement>();
	let query = $state('');
	let scrollRoot = $state<HTMLElement>();
	let bookmarkDraft = $state<BookmarkDraft | null>(null);
	let selectedColor = $state<HighlightColor>('yellow');
	let engine = $state<FoliateReader | null>(null);
	let announcement = $state('');
	let sidebarSelection = $state.raw<ReaderSelection | null>(null);
	const tabs: readonly SidebarTab[] = untrack(() => controller.format === 'cbz'
		? ['toc', 'annotations', 'bookmarks']
		: ['toc', 'annotations', 'bookmarks', 'search']);
	const sidebar = createSidebarState({ tabs });
	const sidebarInset = $derived(RAIL_WIDTH + (sidebar.open && sidebar.docked ? PANEL_WIDTH : 0));
	const background = $derived(backgroundFor(controller.settings));
	const progressPercent = $derived(Math.round((controller.location?.fraction ?? 0) * 100));
	const currentBookmarks = $derived.by(() => {
		// Relocation includes sidebar/typography reflows even when the fraction stays unchanged.
		if (!controller.location || !engine) return [];
		return controller.availableBookmarks.filter((bookmark) => engine!.isOnCurrentPage(bookmark.locator));
	});
	const annotationList = $derived(buildAnnotationList({
		highlights: controller.highlights, notes: controller.notes, pageAnnotations: [],
		fileId: controller.file?.id ?? -1, locatorType: 'cfi'
	}));
	const entries = $derived(filterEntries(annotationList.entries, query));
	const otherEntries = $derived(filterEntries(annotationList.otherFile, query));
	const detailEntry = $derived([...annotationList.entries, ...annotationList.otherFile].find((entry) => entry.id === detail?.id));
	$effect(() => {
		if (detailHost && detail && !draft) detailHost.querySelector('button')?.focus({ preventScroll: true });
	});
	$effect(() => {
		if (draft?.highlightId && !controller.highlights.some((highlight) => highlight.id === draft?.highlightId)) draft = null;
		if (draft?.editing && !controller.notes.some((note) => note.id === draft?.id)) draft = null;
		if (bookmarkDraft?.editing && !controller.bookmarks.some((bookmark) => bookmark.id === bookmarkDraft?.id)) bookmarkDraft = null;
	});
	$effect(() => {
		const reader = engine;
		if (!reader) return;
		return reader.subscribeSelection((reason) => {
			// Opening a docked sidebar reflows the book and emits a relocation, which clears
			// controller.selection. Keep the actual user selection for the sidebar action.
			if (!reason && reader.getSelectionBounds() && controller.selection) sidebarSelection = controller.selection;
		});
	});
	$effect(() => {
		if (!engine) return;
		return engine.subscribeAnnotation((id) => {
			const note = controller.notes.find((item) => item.highlight_id === id);
			if (!note || controller.busy) return;
			clearSelection();
			openNote(id, note);
		});
	});
	onMount(() => {
		if (!surface) throw new Error('The reader surface is unavailable.');
		readerChrome.set('full');
		controller.setDraftGuard(() => {
			if (!canOpenNote()) return false;
			if (bookmarkDraft && bookmarkDraft.label !== bookmarkDraft.original && !window.confirm(m['ux6.discard_confirm']())) return false;
			return true;
		});
		let destroyed = false;
		void controller.attach(surface).then((reader) => {
			if (destroyed) return;
			if (!(reader instanceof FoliateReader)) throw new Error('The attached reader does not support reflowable view controls.');
			engine = reader;
		}).catch((error) => {
			console.error('Could not open the reader view', error);
			if (!destroyed) readerChrome.set('default');
		});
		return () => {
			destroyed = true;
			controller.setDraftGuard(() => true);
			sidebar.dispose();
			readerChrome.set('default');
		};
	});
	async function goToContents(href: string) {
		try {
			if (!engine) throw new Error('The reader is not ready.');
			clearSelection();
			announcement = '';
			await engine.goToContents(href);
			if (!sidebar.docked) sidebar.collapse();
		} catch (error) {
			console.error('Could not navigate to the book contents destination', error);
			announcement = m['reader.error.render']();
		}
	}
	function openNote(highlightId: string | null, note?: Note) {
		if (!canOpenNote()) return;
		noteTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		createdCommentMark = null;
		draft = { id: note?.id ?? uuidv7(), highlightId, body: note?.body_md ?? '', original: note?.body_md ?? '', editing: !!note };
	}
	function canOpenNote() {
		const body = stickyHost?.querySelector('textarea')?.value ?? draft?.body;
		return !draft || body === draft.original || window.confirm(m['reader.note.discard_confirm']());
	}
	function commentOnSelection(highlightId: string) {
		noteTrigger = surface ?? null;
		createdCommentMark = highlightId;
		draft = { id: uuidv7(), highlightId, body: '', original: '', editing: false };
	}
	async function addSidebarHighlight() {
		const created = await controller.addHighlight(sidebarSelection, selectedColor);
		if (created) clearSelection();
	}
	function clearSelection() {
		sidebarSelection = null;
		engine?.clearSelection();
	}
	function navigate(action: () => unknown) {
		clearSelection();
		return action();
	}
	function rotate(delta: -90 | 90) {
		try {
			if (!engine) throw new Error('The reader is not ready.');
			clearSelection();
			engine.rotate(delta);
		} catch (error) {
			console.error('Could not rotate the reader view', error);
			announcement = m['reader.error.render']();
		}
	}
	async function addToolbarHighlight() {
		const created = await controller.addHighlight(controller.selection ?? sidebarSelection, selectedColor);
		if (created) {
			clearSelection();
			sidebar.show('annotations');
		}
	}
	async function toggleBookmark() {
		if (!engine || !controller.ready || controller.busy) return;
		const existing = currentBookmarks[0];
		if (existing) {
			await controller.removeBookmark(existing, { confirm: false });
			return;
		}
		const selected = engine.getSelectionBounds() ? controller.selection?.text : null;
		await controller.addBookmark({ label: bookmarkExcerpt(selected || engine.getBookmarkText()) });
	}
	async function jumpBookmark(bookmark: Bookmark) {
		if (await navigate(() => controller.jumpToBookmark(bookmark)) && !sidebar.docked) sidebar.collapse();
	}
	async function cancelNote(body: string) {
		if (controller.busy) return;
		const created = createdCommentMark;
		draft = null;
		createdCommentMark = null;
		if (created && !body.trim()) {
			const highlight = controller.highlights.find((row) => row.id === created);
			if (highlight) await controller.removeHighlight(highlight, { confirm: false });
		}
		restoreNoteFocus();
	}
	function restoreNoteFocus() {
		void tick().then(() => {
			const target = noteTrigger?.isConnected ? noteTrigger : detailHost?.querySelector('button') ?? surface;
			target?.focus({ preventScroll: true });
		});
	}
	async function saveNote(body: string) {
		if (draft && await controller.saveNote({ ...draft, body })) {
			draft = null;
			createdCommentMark = null;
			sidebar.show('annotations');
			restoreNoteFocus();
		}
	}
	function editAnnotation(entry: AnnotationEntry, trigger: HTMLButtonElement, readonly = false) {
		if (!canOpenNote()) return;
		draft = null;
		detail = { id: entry.id, readonly, trigger };
	}
	function closeDetail() {
		const trigger = detail?.trigger;
		detail = null;
		void tick().then(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
	}
	async function jumpAnnotation(entry: AnnotationEntry): Promise<boolean> {
		if (entry.kind !== 'mark' || !controller.file || !controller.format || !annotationForReader(entry.row, controller.file.id, controller.format)) return false;
		await navigate(() => controller.goToHighlight(entry.row));
		if (!sidebar.docked) sidebar.collapse();
		return true;
	}
	async function removeAnnotation(entry: AnnotationEntry): Promise<boolean> {
		if (entry.kind !== 'mark' || !canOpenNote()) return false;
		const removed = !!await controller.removeHighlight(entry.row, { confirm: false });
		if (removed && detail?.id === entry.id) closeDetail();
		return removed;
	}
	function editBookmark(bookmark: Bookmark) {
		bookmarkDraft = { id: bookmark.id, label: bookmark.label, original: bookmark.label, editing: true };
	}
	async function saveBookmark() {
		if (!bookmarkDraft) return;
		const existing = controller.bookmarks.find((bookmark) => bookmark.id === bookmarkDraft?.id);
		const saved = existing && await controller.updateBookmark(existing, bookmarkDraft);
		if (saved) bookmarkDraft = null;
	}
	function colorLabel(color: HighlightColor): string {
		switch (color) {
			case 'yellow': return m['reader.annotations.yellow']();
			case 'green': return m['reader.annotations.green']();
			case 'blue': return m['reader.annotations.blue']();
			case 'pink': return m['reader.annotations.pink']();
			case 'orange': return m['reader.annotations.orange']();
			case 'purple': return m['reader.annotations.purple']();
		}
	}
</script>

{#if controller.book && controller.file && controller.format}
	<ReaderFrame title={controller.book.title}>
		{#snippet toolbar()}
			<ReaderToolbar>
				{#snippet left()}
					<button class="pv4-button" aria-label={m['reader.previous']()} title={m['reader.previous']()} disabled={!controller.ready} onclick={() => navigate(() => controller.turnPage('previous'))}><Icon name="chevron-left" /></button>
					<ProgressLabel fraction={controller.location?.fraction ?? 0} />
					<button class="pv4-button" aria-label={m['reader.next']()} title={m['reader.next']()} disabled={!controller.ready} onclick={() => navigate(() => controller.turnPage('next'))}><Icon name="chevron-right" /></button>
				{/snippet}
				{#snippet status()}<ReaderStatusDot warning={controller.settingsWarning} onretry={() => controller.retryWrites()} />{/snippet}
				{#snippet centre()}<h1 class="reader-title">{controller.book?.title}</h1>{/snippet}
				{#snippet overflow()}
					<ReflowSizeMenu size={controller.settings.size} typography={controller.format !== 'cbz'}
						disabled={!controller.ready} onsize={(size) => controller.applySettings({ size })} />
					{#if controller.format !== 'cbz'}
						<ReflowLayoutMenu flow={controller.settings.flow} disabled={!controller.ready}
							onflow={(flow) => controller.applySettings({ flow })} />
					{/if}
					<FormatMenu typography={controller.format !== 'cbz'}
						label={controller.format === 'cbz' ? m['pv4.display']() : m['rp2.format']()}
						icon={controller.format === 'cbz' ? 'layout-single' : undefined}
						font={controller.settings.font} size={controller.settings.size} spacing={controller.settings.spacing}
						background={background.id}
						onfont={(font) => controller.applySettings({ font })}
						onsize={(size) => controller.applySettings({ size })}
						onspacing={(spacing) => controller.applySettings({ spacing })}
						onbackground={(id) => controller.applySettings(withBackground(controller.settings, id))}>
						<div class="mt-4 space-y-3">
							<p class="text-xs opacity-75">{m['reader.settings.scope']()}</p>
							<button class="reader-action" disabled={!controller.ready || controller.busy || !controller.canSaveSettings} onclick={() => controller.saveSettings()}>{m['reader.settings.save']()}</button>
							<button class="reader-action" disabled={!controller.ready || controller.busy} onclick={() => controller.saveSettings({}, 'format')}>{m['rp9.save_format']()}</button>
						</div>
					</FormatMenu>
					<RotateMenu onrotate={rotate} disabled={!engine} />
				{/snippet}
				{#snippet right()}
					<ToolbarMenu label={m['reader.add']()} icon="insert">
						<MenuItem label={controller.format === 'cbz' ? m['reader.annotations.add_page']() : m['reader.annotations.add_highlight']()}
							icon="highlighter" disabled={!controller.ready || controller.busy || (!controller.selection && !sidebarSelection && controller.format !== 'cbz')}
							onchoose={() => void addToolbarHighlight()} />
						<MenuItem label={m['reader.annotations.add_note']()} icon="message"
							disabled={!controller.ready || controller.busy} onchoose={() => openNote(null)} />
					</ToolbarMenu>
					<button class="pv4-button" data-testid="reflow-bookmark-toggle"
						aria-label={m['rp8.add_page']()} aria-pressed={currentBookmarks.length > 0}
						title={currentBookmarks.length ? m['rp8.remove_page']() : m['rp8.add_page']()}
						disabled={!controller.ready || controller.busy}
						onpointerdown={(event) => event.preventDefault()} onclick={() => void toggleBookmark()}>
						<Icon name="bookmark" />
					</button>
					<span class="reader-divider" aria-hidden="true"></span>
					<ReaderCloseButton closing={controller.closing} onclose={() => controller.close()} />
				{/snippet}
			</ReaderToolbar>
		{/snippet}
		<div class="absolute inset-y-0 right-0 flex min-w-0 flex-col" style:left="{sidebarInset}px">
			<!-- svelte-ignore a11y_no_noninteractive_tabindex: the book surface must be keyboard-scrollable -->
			<div bind:this={surface} id="reader-surface" role="region" aria-label={m['reader.surface']()} tabindex="0"
				data-background={background.id} data-tone={background.tone}
				class="min-h-0 flex-1 overflow-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-500"></div>
			<div class="reader-position flex items-center gap-3 px-4 py-2">
				<label for="reader-position" class="sr-only">{m['reader.position']()}</label>
				<input id="reader-position" class="min-w-0 flex-1 accent-emerald-700" type="range" min="0" max="1000" value={Math.round((controller.location?.fraction ?? 0) * 1000)} aria-valuetext={`${progressPercent}%`} disabled={!controller.ready} onchange={(event) => navigate(() => controller.goToFraction(Number(event.currentTarget.value) / 1000))} />
				<p class="sr-only">{m['reader.keyboard_hint']()}</p>
			</div>
		</div>
		{#if engine && surface && controller.format !== 'cbz'}
			<ReflowSelectionToolbar {engine} {controller} {surface} cancomment={canOpenNote}
				oncomment={commentOnSelection} onclear={() => sidebarSelection = null} onerror={(message) => announcement = message} />
		{/if}
		<ReaderSidebar {sidebar} {tabs} count={annotationList.count}>
			{#snippet children(tab)}
				{#if controller.file && controller.format}
				<div class="reader-panel text-sm" class:reader-annotations-panel={tab === 'annotations'} class:p-4={tab !== 'annotations'}>
				{#if tab === 'search' && controller.format !== 'cbz'}
					{#if engine}
						<SearchPanel {engine} />
					{:else}
						<p role="status">{m['reader.loading']()}</p>
					{/if}
				{:else if tab === 'toc'}
					{#if !engine}
						<p role="status">{m['reader.loading']()}</p>
					{:else if engine.contents.length}
						{@render contents(engine.contents)}
					{:else}
						<p class="opacity-75">{m['reader.contents.empty']()}</p>
					{/if}
				{:else if tab === 'annotations'}
		<section aria-labelledby="annotations-heading" class="rp7-tab">
			<h2 id="annotations-heading" class="sr-only">{m['reader.annotations.title']()}</h2>
			<header class="rp7-header">
				<form class="min-w-0 flex-1" role="search" onsubmit={(event) => event.preventDefault()}>
					<SearchField label={m['pv10.search']()} placeholder={m['pv10.search']()} bind:value={query} clear={query.trim() !== ''} onclear={() => query = ''} />
				</form>
				<span class="rp7-count">{m['rp7.count']({ count: annotationList.count })}</span>
			</header>
			<div class="rp7-content" bind:this={scrollRoot}>
			{#if sidebarSelection}
				<div class="reader-selection p-3">
					<p class="font-medium">{m['reader.annotations.selected']()}</p>
					<p class="mt-1 whitespace-pre-wrap break-words">{sidebarSelection.text}</p>
				</div>
			{/if}
			{#if sidebarSelection || controller.format === 'cbz'}
			<div class="flex flex-wrap items-end gap-3 p-3">
				<label class="space-y-1 text-sm font-medium">
					<span>{m['reader.annotations.color']()}</span>
					<select class="block rounded-md border border-slate-300 bg-white p-2 focus-visible:outline-2" bind:value={selectedColor}>
						{#each HIGHLIGHT_COLORS as color}<option value={color}>{colorLabel(color)}</option>{/each}
					</select>
				</label>
				<button class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" disabled={!controller.ready || controller.busy || (!sidebarSelection && controller.format !== 'cbz')} onclick={addSidebarHighlight}>
					{controller.format === 'cbz' && !sidebarSelection ? m['reader.annotations.add_page']() : m['reader.annotations.add_highlight']()}
				</button>
			</div>
			{/if}
			{#if !entries.length && (!query.trim() || !otherEntries.length)}
				<p class="rp7-empty">{query.trim() ? m['rp7.no_match']() : m['rp7.empty']()}</p>
			{/if}
			<VirtualList {entries} {scrollRoot} virtual={entries.length + otherEntries.length > VIRTUAL_THRESHOLD}
				busy={controller.busy} target={null} onjump={jumpAnnotation} onedit={editAnnotation}
				ondelete={removeAnnotation} onexpand={editAnnotation} />
			{#if otherEntries.length}
				<details class="rp7-other">
					<summary>{m['rp7.other_files']()} ({otherEntries.length})</summary>
					<VirtualList entries={otherEntries} {scrollRoot} virtual={entries.length + otherEntries.length > VIRTUAL_THRESHOLD}
						readonly busy={controller.busy} target={null} onjump={jumpAnnotation}
						ondelete={removeAnnotation} onexpand={editAnnotation} />
				</details>
			{/if}
			</div>
		</section>

				{:else if tab === 'bookmarks'}
		<section aria-labelledby="bookmarks-heading" class="space-y-4">
			<div class="flex items-center justify-between">
				<h2 id="bookmarks-heading" class="text-xl font-semibold">{m['ux6.title']()}</h2>
			</div>
			{#if bookmarkDraft}
				<form class="space-y-3 rounded-md border border-slate-300 bg-slate-50 p-4" onsubmit={(event) => { event.preventDefault(); void saveBookmark(); }}>
					<h3 class="font-semibold">{m['ux6.edit_title']()}</h3>
					<label class="space-y-1 text-sm font-medium">
						<span>{m['ux6.label']()}</span>
						<input
							type="text"
							class="block w-full rounded-md border border-slate-300 p-2 focus-visible:outline-2"
							bind:value={bookmarkDraft.label}
							maxlength="512"
							disabled={controller.busy}
						/>
					</label>
					<div class="flex flex-wrap gap-3">
						<button type="submit" class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" disabled={controller.busy}>{m['ux6.save']()}</button>
						<button type="button" class="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2" disabled={controller.busy} onclick={() => { bookmarkDraft = null; }}>{m['ux6.cancel']()}</button>
					</div>
				</form>
			{/if}

			{#if !controller.bookmarks.length}
				<p class="text-slate-600">{m['ux6.empty']()}</p>
			{:else}
				<ul class="space-y-3">
					{#each controller.bookmarks as bookmark (bookmark.id)}
						<li class="reflow-bookmark" data-bookmark-id={bookmark.id}>
							<button class="reflow-bookmark-jump" data-bookmark-jump
								disabled={controller.busy || !controller.ready || !bookmarkForPosition(bookmark, controller.file.id, controller.format)}
								onclick={() => void jumpBookmark(bookmark)}>
								<span class="reflow-bookmark-meta">
									<time datetime={bookmark.created_at}>{new Date(bookmark.created_at).toLocaleString()}</time>
									<span class="reflow-bookmark-progress">{(Math.round(bookmark.position * 1000) / 10).toFixed(1)}%</span>
								</span>
								<span class="reflow-bookmark-label" data-bookmark-label title={bookmark.label}>{bookmark.label || m['ux6.unnamed']()}</span>
							</button>
							<div class="reflow-bookmark-actions">
								<button class="pv4-button" aria-label={m['ux6.edit']()} title={m['ux6.edit']()} disabled={controller.busy || bookmark.book_file_id === null} onclick={() => editBookmark(bookmark)}><Icon name="pencil" /></button>
								<button class="pv4-button" aria-label={m['ux6.delete']()} title={m['ux6.delete']()} disabled={controller.busy} onclick={() => void controller.removeBookmark(bookmark)}><Icon name="trash" /></button>
							</div>
							{#if !bookmarkForPosition(bookmark, controller.file.id, controller.format)}
								<p class="px-3 pb-2 text-sm text-amber-800">{m['ux6.unavailable']()}</p>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
				{/if}
				</div>
				{/if}
			{/snippet}
		</ReaderSidebar>
		{#if detail && detailEntry?.kind === 'mark' && !draft}
			<div bind:this={detailHost} class="reader-annotation-detail" role="dialog" tabindex="-1" aria-label={m['reader.annotations.edit']()}
				onkeydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeDetail(); } }}>
				<header class="flex items-center justify-between gap-3">
					<h2>{m['reader.annotations.title']()}</h2>
					<button class="reader-action" aria-label={m['rp7.close']()} onclick={closeDetail}><Icon name="x" /></button>
				</header>
				<blockquote class="rp7-quote">{detailEntry.row.text || m['reader.annotations.page_highlight']()}</blockquote>
				{#if !detail.readonly}
					<label class="block space-y-1">
						<span>{m['reader.annotations.color']()}</span>
						<select class="reader-action" aria-label={m['reader.annotations.color']()} value={highlightColor(detailEntry.row.color)} disabled={controller.busy}
							onchange={(event) => { if (detailEntry?.kind === 'mark') void controller.updateHighlight(detailEntry.row, { color: event.currentTarget.value }); }}>
							{#if !HIGHLIGHT_COLORS.includes(highlightColor(detailEntry.row.color) as HighlightColor)}
								<option value={highlightColor(detailEntry.row.color)}>{detailEntry.row.color}</option>
							{/if}
							{#each HIGHLIGHT_COLORS as color}<option value={color}>{colorLabel(color)}</option>{/each}
						</select>
					</label>
					<button class="reader-action" disabled={controller.busy} onclick={() => openNote(detailEntry!.id)}>{m['reader.annotations.attach_note']()}</button>
				{/if}
				{#each detailEntry.notes as note (note.id)}
					<div class="space-y-2">
						<p class="whitespace-pre-wrap break-words">{note.body_md}</p>
						{#if !detail.readonly}
							<div class="flex gap-3">
								<button class="reader-action" disabled={controller.busy} onclick={() => openNote(note.highlight_id, note)}>{m['reader.annotations.edit']()}</button>
								<button class="reader-action" disabled={controller.busy} onclick={() => controller.deleteNote(note)}>{m['reader.annotations.delete']()}</button>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
		{#if draft}
			<div class="reader-sticky-popup" bind:this={stickyHost}>
				{#key draft.id}
					<StickyNote initial={draft.original} disabled={controller.busy} onchange={(body) => { if (draft) draft.body = body; }} onsave={saveNote} oncancel={cancelNote} />
				{/key}
			</div>
		{/if}
		{#if controller.pendingError || controller.actionError || controller.opening || controller.savedMessage || announcement}
			<div class="reader-alert absolute inset-x-2 top-2 z-20 max-h-[50%] overflow-auto rounded-md p-3 text-sm shadow-md">
				{#if controller.pendingError}
					<div role="alert" class="space-y-2">
						<p>{controller.pendingError}</p>
						<button class="underline focus-visible:outline-2" onclick={() => controller.retryWrites()}>{m['reader.retry_saves']()}</button>
						<a class="ml-4 underline focus-visible:outline-2" href={`/books/${controller.book.id}`}>{m['reader.leave_unsaved']()}</a>
					</div>
				{/if}
				{#if controller.actionError}<p role="alert">{controller.actionError}</p>{/if}
				{#if announcement}<p role="alert">{announcement}</p>{/if}
				{#if controller.savedMessage}<p role="status">{controller.savedMessage}</p>{/if}
				{#if controller.opening}<p role="status">{m['reader.loading']()}</p>{/if}
			</div>
		{/if}
	</ReaderFrame>
{/if}

{#snippet contents(items: FoliateTocItem[])}
	<ul class="space-y-2">
		{#each items as item}
			{@const href = item.href}
			<li>
				{#if href}
					<button class="w-full rounded-md px-2 py-1 text-left hover:bg-black/5 focus-visible:outline-2" onclick={() => goToContents(href)}>{item.label}</button>
				{:else}<span>{item.label}</span>{/if}
				{#if item.subitems?.length}<div class="mt-2 border-l border-[var(--shell-border)] pl-3">{@render contents(item.subitems)}</div>{/if}
			</li>
		{/each}
	</ul>
{/snippet}
<style>
	.reader-title { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 400; }
	.reader-divider { width: 1px; height: 20px; margin: 0 2px; background: var(--shell-border, #94a3b8); flex: none; }
	.reader-position, .reader-alert { background: var(--pv-chrome); color: var(--shell-text); }
	.reader-action { border: 1px solid var(--shell-border); border-radius: 6px; padding: 6px 10px; }
	.reader-action:disabled { opacity: .5; }
	.reflow-bookmark { position: relative; border: 1px solid var(--shell-border); border-radius: 6px; background: var(--shell-surface); }
	.reflow-bookmark-jump { display: block; width: 100%; min-width: 0; padding: 10px 12px; text-align: left; border-radius: 6px; }
	.reflow-bookmark-jump:hover:not(:disabled) { background: color-mix(in srgb, var(--shell-text) 5%, transparent); }
	.reflow-bookmark-jump:focus-visible { outline: 2px solid var(--shell-accent, #059669); outline-offset: -2px; }
	.reflow-bookmark-jump:disabled { opacity: .6; }
	.reflow-bookmark-meta { display: flex; align-items: center; gap: 6px; min-height: 32px; padding-right: 64px; color: var(--shell-muted); font-size: 11px; }
	.reflow-bookmark-meta time { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
	.reflow-bookmark-progress { margin-left: auto; flex: none; }
	.reflow-bookmark-label { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
	.reflow-bookmark-actions { position: absolute; top: 10px; right: 8px; display: flex; }
	.reflow-bookmark-actions .pv4-button { width: 30px; height: 32px; }
	:global(.pv4-button[aria-pressed='true'][data-testid='reflow-bookmark-toggle']) { background: color-mix(in srgb, var(--shell-accent, #059669) 15%, transparent); color: var(--shell-accent, #059669); }
	.reader-panel :global(.bg-white), .reader-panel :global(.bg-slate-50) { background: var(--shell-surface); color: var(--shell-text); }
	.reader-panel :global(.text-slate-600) { color: var(--shell-muted); }
	.reader-panel :global(select), .reader-panel :global(input) { background: var(--shell-surface); color: var(--shell-text); }
	.reader-annotations-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
	.reader-selection { background: var(--shell-surface); color: var(--shell-text); }
	.reader-sticky-popup, .reader-annotation-detail { position: absolute; z-index: 30; top: 16px; right: 16px; max-width: calc(100% - 32px); }
	.reader-annotation-detail { width: 360px; max-height: calc(100% - 32px); overflow: auto; padding: 16px; border: 1px solid var(--shell-border); border-radius: 8px; background: var(--shell-surface); color: var(--shell-text); box-shadow: 0 8px 24px #0003; }
	.reader-annotation-detail > :global(*) + :global(*) { margin-top: 12px; }
</style>
