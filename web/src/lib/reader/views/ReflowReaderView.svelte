<script lang="ts">
	import { onMount } from 'svelte';
	import { v7 as uuidv7 } from 'uuid';
	import * as m from '#lib/paraglide/messages.js';
	import { annotationForReader, highlightColor, HIGHLIGHT_COLORS, type HighlightColor } from '#lib/reader/annotations.js';
	import { bookmarkForPosition } from '#lib/reader/bookmarks.js';
	import { renderMarkdown } from '#lib/reader/markdown.js';
	import NoteEditor from '#lib/reader/NoteEditor.svelte';
	import FormatMenu from '#lib/reader/toolbar/FormatMenu.svelte';
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
	import type { Bookmark, Note } from '#lib/reader/types.js';
	import type { ReaderController, NoteDraft, BookmarkDraft } from '#lib/reader/session/reader-controller.svelte.js';
	let { controller }: { controller: ReaderController } = $props();
	let surface = $state<HTMLDivElement>();
	let draft = $state<NoteDraft | null>(null);
	let bookmarkDraft = $state<BookmarkDraft | null>(null);
	let selectedColor = $state<HighlightColor>('yellow');
	let engine = $state<FoliateReader | null>(null);
	let announcement = $state('');
	const tabs: readonly SidebarTab[] = ['toc', 'annotations', 'bookmarks'];
	const sidebar = createSidebarState({ tabs });
	const sidebarInset = $derived(RAIL_WIDTH + (sidebar.open && sidebar.docked ? PANEL_WIDTH : 0));
	const background = $derived(backgroundFor(controller.settings));
	const progressPercent = $derived(Math.round((controller.location?.fraction ?? 0) * 100));
	$effect(() => {
		if (draft?.highlightId && !controller.highlights.some((highlight) => highlight.id === draft?.highlightId)) draft = null;
		if (draft?.editing && !controller.notes.some((note) => note.id === draft?.id)) draft = null;
		if (bookmarkDraft?.editing && !controller.bookmarks.some((bookmark) => bookmark.id === bookmarkDraft?.id)) bookmarkDraft = null;
	});
	onMount(() => {
		if (!surface) throw new Error('The reader surface is unavailable.');
		readerChrome.set('full');
		controller.setDraftGuard(() => {
			if (draft && draft.body !== draft.original && !window.confirm(m['reader.note.discard_confirm']())) return false;
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
			announcement = '';
			await engine.goToContents(href);
			if (!sidebar.docked) sidebar.collapse();
		} catch (error) {
			console.error('Could not navigate to the book contents destination', error);
			announcement = m['reader.error.render']();
		}
	}
	function openNote(highlightId: string | null, note?: Note) {
		if (draft && draft.body !== draft.original && !window.confirm(m['reader.note.discard_confirm']())) return;
		draft = { id: note?.id ?? uuidv7(), highlightId, body: note?.body_md ?? '', original: note?.body_md ?? '', editing: !!note };
	}
	function cancelNote() {
		if (draft && draft.body !== draft.original && !window.confirm(m['reader.note.discard_confirm']())) return;
		draft = null;
	}
	async function saveNote() {
		if (draft && await controller.saveNote(draft)) draft = null;
	}
	function editBookmark(bookmark: Bookmark) {
		bookmarkDraft = { id: bookmark.id, label: bookmark.label, original: bookmark.label, editing: true };
	}
	async function saveBookmark() {
		if (!bookmarkDraft) return;
		const existing = controller.bookmarks.find((bookmark) => bookmark.id === bookmarkDraft?.id);
		const saved = existing
			? await controller.updateBookmark(existing, bookmarkDraft)
			: await controller.addBookmark(bookmarkDraft);
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
					<button class="pv4-button" aria-label={m['reader.previous']()} title={m['reader.previous']()} disabled={!controller.ready} onclick={() => controller.turnPage('previous')}><Icon name="chevron-left" /></button>
					<ProgressLabel fraction={controller.location?.fraction ?? 0} />
					<button class="pv4-button" aria-label={m['reader.next']()} title={m['reader.next']()} disabled={!controller.ready} onclick={() => controller.turnPage('next')}><Icon name="chevron-right" /></button>
				{/snippet}
				{#snippet status()}<ReaderStatusDot warning={controller.settingsWarning} onretry={() => controller.retryWrites()} />{/snippet}
				{#snippet centre()}<h1 class="reader-title">{controller.book?.title}</h1>{/snippet}
				{#snippet overflow()}
					<FormatMenu typography={controller.format !== 'cbz'}
						font={controller.settings.font} size={controller.settings.size} spacing={controller.settings.spacing}
						background={background.id}
						onfont={(font) => controller.applySettings({ font })}
						onsize={(size) => controller.applySettings({ size })}
						onspacing={(spacing) => controller.applySettings({ spacing })}
						onbackground={(id) => controller.applySettings(withBackground(controller.settings, id))}>
						<div class="mt-4 space-y-3">
							{#if controller.format !== 'cbz'}
								<label class="block space-y-1 text-sm">
									<span>{m['reader.settings.flow']()}</span>
									<select class="block w-full rounded-md border border-[var(--shell-border)] bg-[var(--shell-surface)] p-2" value={controller.settings.flow} onchange={(event) => controller.applySettings({ flow: event.currentTarget.value === 'scrolled' ? 'scrolled' : 'paginated' })} disabled={!controller.ready}>
										<option value="paginated">{m['reader.settings.paginated']()}</option>
										<option value="scrolled">{m['reader.settings.scrolled']()}</option>
									</select>
								</label>
							{:else}
								<label class="block text-sm">{m['rp2.size']()} <input aria-label={m['rp2.size']()} type="range" min="50" max="200" step="10" value={controller.settings.size} oninput={(event) => controller.applySettings({ size: Number(event.currentTarget.value) })} /></label>
							{/if}
							<p class="text-xs opacity-75">{m['reader.settings.scope']()}</p>
							<button class="reader-action" disabled={!controller.ready || controller.busy || !controller.canSaveSettings} onclick={() => controller.saveSettings()}>{m['reader.settings.save']()}</button>
							<button class="reader-action" disabled={!controller.ready || controller.busy} onclick={() => controller.saveSettings({}, 'format')}>{m['rp9.save_format']()}</button>
						</div>
					</FormatMenu>
				{/snippet}
				{#snippet right()}<ReaderCloseButton closing={controller.closing} onclose={() => controller.close()} />{/snippet}
			</ReaderToolbar>
		{/snippet}
		<div class="absolute inset-y-0 right-0 flex min-w-0 flex-col" style:left="{sidebarInset}px">
			<!-- svelte-ignore a11y_no_noninteractive_tabindex: the book surface must be keyboard-scrollable -->
			<div bind:this={surface} id="reader-surface" role="region" aria-label={m['reader.surface']()} tabindex="0"
				data-background={background.id} data-tone={background.tone}
				class="min-h-0 flex-1 overflow-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-500"></div>
			<div class="reader-position flex items-center gap-3 px-4 py-2">
				<label for="reader-position" class="sr-only">{m['reader.position']()}</label>
				<input id="reader-position" class="min-w-0 flex-1 accent-emerald-700" type="range" min="0" max="1000" value={Math.round((controller.location?.fraction ?? 0) * 1000)} aria-valuetext={`${progressPercent}%`} disabled={!controller.ready} onchange={(event) => controller.goToFraction(Number(event.currentTarget.value) / 1000)} />
				<p class="sr-only">{m['reader.keyboard_hint']()}</p>
			</div>
		</div>
		<ReaderSidebar {sidebar} {tabs} count={controller.highlights.length}>
			{#snippet children(tab)}
				{#if controller.file && controller.format}
				<div class="reader-panel space-y-4 p-4 text-sm">
				{#if tab === 'toc'}
					{#if !engine}
						<p role="status">{m['reader.loading']()}</p>
					{:else if engine.contents.length}
						{@render contents(engine.contents)}
					{:else}
						<p class="opacity-75">{m['reader.contents.empty']()}</p>
					{/if}
				{:else if tab === 'annotations'}
		<section aria-labelledby="annotations-heading" class="space-y-4">
			<h2 id="annotations-heading" class="text-xl font-semibold">{m['reader.annotations.title']()}</h2>
			<p class="text-sm text-slate-600">{m['reader.annotations.description']()}</p>
			{#if controller.selection}
				<div class="rounded-md border-l-4 border-yellow-400 bg-yellow-50 p-3 text-sm text-slate-900">
					<p class="font-medium">{m['reader.annotations.selected']()}</p>
					<p class="mt-1 whitespace-pre-wrap break-words">{controller.selection.text}</p>
				</div>
			{/if}
			<div class="flex flex-wrap items-end gap-3">
				<label class="space-y-1 text-sm font-medium">
					<span>{m['reader.annotations.color']()}</span>
					<select class="block rounded-md border border-slate-300 bg-white p-2 focus-visible:outline-2" bind:value={selectedColor}>
						{#each HIGHLIGHT_COLORS as color}<option value={color}>{colorLabel(color)}</option>{/each}
					</select>
				</label>
				<button class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" disabled={!controller.ready || controller.busy || (!controller.selection && controller.format !== 'cbz')} onclick={() => controller.addHighlight(controller.selection, selectedColor)}>
					{controller.format === 'cbz' && !controller.selection ? m['reader.annotations.add_page']() : m['reader.annotations.add_highlight']()}
				</button>
			</div>

			{#if draft}
				<form class="space-y-4 rounded-md border border-slate-300 bg-slate-50 p-4" onsubmit={(event) => { event.preventDefault(); void saveNote(); }}>
					<h3 class="font-semibold">{draft.editing ? m['reader.note.edit']() : m['reader.note.new']()}</h3>
					{#key draft.id}
						<NoteEditor value={draft.body} onChange={(value) => { if (draft) draft.body = value; }} />
					{/key}
					<div class="flex flex-wrap gap-3">
						<button class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" disabled={controller.busy || !draft.body.trim()}>{m['reader.note.save']()}</button>
						<button type="button" class="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2" onclick={cancelNote}>{m['reader.note.cancel']()}</button>
					</div>
				</form>
			{/if}

			{#if !controller.highlights.length && !controller.notes.length}
				<p class="text-slate-600">{m['reader.annotations.empty']()}</p>
			{/if}
			{#each controller.orderedHighlights as highlight (highlight.id)}
				<div class="space-y-3 rounded-md border border-slate-200 bg-white p-4">
					<blockquote class="whitespace-pre-wrap break-words border-l-4 border-yellow-400 pl-3">{highlight.text || m['reader.annotations.page_highlight']()}</blockquote>
					<div class="flex flex-wrap items-end gap-3 text-sm">
						{#if annotationForReader(highlight, controller.file.id, controller.format)}
							<button class="underline focus-visible:outline-2" onclick={() => controller.goToHighlight(highlight)}>{m['reader.annotations.go_to']()}</button>
						{:else}
							<span class="text-slate-600">{m['reader.annotations.other_file']()}</span>
						{/if}
						<label class="space-y-1">
							<span>{m['reader.annotations.color']()}</span>
							<select class="block rounded-md border border-slate-300 p-1 focus-visible:outline-2" value={highlightColor(highlight.color)} disabled={controller.busy} onchange={(event) => controller.updateHighlight(highlight, { color: event.currentTarget.value })}>
								{#each HIGHLIGHT_COLORS as color}<option value={color}>{colorLabel(color)}</option>{/each}
							</select>
						</label>
						<button class="underline focus-visible:outline-2" disabled={controller.busy} onclick={() => openNote(highlight.id)}>{m['reader.annotations.attach_note']()}</button>
						<button class="underline focus-visible:outline-2" disabled={controller.busy} onclick={() => controller.removeHighlight(highlight)}>{m['reader.annotations.delete']()}</button>
					</div>
					{#each controller.notes.filter((note) => note.highlight_id === highlight.id) as note (note.id)}
						<div class="space-y-2 rounded-md bg-slate-50 p-3">
							<div class="reader-markdown break-words text-sm">{@html renderMarkdown(note.body_md)}</div>
							<div class="flex gap-4 text-sm">
								<button class="underline focus-visible:outline-2" onclick={() => openNote(highlight.id, note)}>{m['reader.annotations.edit']()}</button>
								<button class="underline focus-visible:outline-2" disabled={controller.busy} onclick={() => controller.deleteNote(note)}>{m['reader.annotations.delete']()}</button>
							</div>
						</div>
					{/each}
				</div>
			{/each}
		</section>

				{:else if tab === 'bookmarks'}
		<section aria-labelledby="bookmarks-heading" class="space-y-4">
			<div class="flex items-center justify-between">
				<h2 id="bookmarks-heading" class="text-xl font-semibold">{m['ux6.title']()}</h2>
			</div>
			<div class="flex flex-wrap gap-3">
				<button class="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900" disabled={!controller.ready || controller.busy} onclick={() => bookmarkDraft = { id: uuidv7(), label: '', original: '', editing: false }}>{m['ux6.save_position']()}</button>
				{#if controller.availableBookmarks.length > 0}
					<select aria-label={m['ux6.jump']()} class="rounded-md border border-slate-300 p-2 focus-visible:outline-2" disabled={!controller.ready || controller.busy} onchange={(event) => {
						const bm = controller.availableBookmarks.find((b) => b.id === event.currentTarget.value);
						if (bm) void controller.jumpToBookmark(bm);
						event.currentTarget.value = '';
					}}>
						<option value="">{m['ux6.jump']()}</option>
						{#each controller.availableBookmarks as bookmark (bookmark.id)}
							<option value={bookmark.id}>{bookmark.label || m['ux6.unnamed']()}</option>
						{/each}
					</select>
				{/if}
			</div>

			{#if bookmarkDraft}
				<form class="space-y-3 rounded-md border border-slate-300 bg-slate-50 p-4" onsubmit={(event) => { event.preventDefault(); void saveBookmark(); }}>
					<h3 class="font-semibold">{bookmarkDraft.editing ? m['ux6.edit_title']() : m['ux6.new_title']()}</h3>
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
				<div class="space-y-3">
					{#each controller.bookmarks as bookmark (bookmark.id)}
						<div class="space-y-2 rounded-md border border-slate-200 bg-white p-4">
							<div class="flex items-start justify-between">
								<div class="min-w-0 flex-1">
									<p class="font-semibold">{bookmark.label || m['ux6.unnamed']()}</p>
									<p class="text-sm text-slate-600">{(Math.round(bookmark.position * 1000) / 10).toFixed(1)}%{bookmark.chapter ? ` — ${bookmark.chapter}` : ''}</p>
									{#if !bookmarkForPosition(bookmark, controller.file.id, controller.format)}
										<p class="text-sm text-amber-800">{m['ux6.unavailable']()}</p>
									{/if}
								</div>
								<time class="whitespace-nowrap text-sm text-slate-600">{new Date(bookmark.created_at).toLocaleDateString()}</time>
							</div>
							<div class="flex flex-wrap gap-3 text-sm">
								<button class="underline focus-visible:outline-2" disabled={controller.busy || !bookmarkForPosition(bookmark, controller.file.id, controller.format)} onclick={() => void controller.jumpToBookmark(bookmark)}>{m['ux6.jump']()}</button>
								<button class="underline focus-visible:outline-2" disabled={controller.busy || bookmark.book_file_id === null} onclick={() => editBookmark(bookmark)}>{m['ux6.edit']()}</button>
								<button class="underline focus-visible:outline-2" disabled={controller.busy} onclick={() => void controller.removeBookmark(bookmark)}>{m['ux6.delete']()}</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>
				{/if}
				</div>
				{/if}
			{/snippet}
		</ReaderSidebar>
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
	.reader-position, .reader-alert { background: var(--pv-chrome); color: var(--shell-text); }
	.reader-action { border: 1px solid var(--shell-border); border-radius: 6px; padding: 6px 10px; }
	.reader-action:disabled { opacity: .5; }
	.reader-panel :global(.bg-white), .reader-panel :global(.bg-slate-50) { background: var(--shell-surface); color: var(--shell-text); }
	.reader-panel :global(.text-slate-600) { color: var(--shell-muted); }
	.reader-panel :global(select), .reader-panel :global(input) { background: var(--shell-surface); color: var(--shell-text); }
	.reader-markdown :global(p),
	.reader-markdown :global(ul),
	.reader-markdown :global(ol),
	.reader-markdown :global(pre) {
		margin-block: 0.5rem;
	}

	.reader-markdown :global(a) {
		color: #1d4ed8;
		text-decoration: underline;
	}
</style>
