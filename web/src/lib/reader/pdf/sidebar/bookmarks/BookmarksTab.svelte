<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import type { Bookmark } from '../../../types.js';
	import { getPdfReaderContext } from '../../context.js';
	import { toFraction } from '../../progress.js';
	import { tabId } from '../SidebarRail.svelte';
	import { bookmarkPage, buildBookmarks, pageBookmark, validateBookmarkLabel } from './bookmarks-model.js';

	const ctx = getPdfReaderContext();
	const controller = ctx.controller;
	let root = $state<HTMLDivElement>();
	let editing = $state<string | null>(null);
	let value = $state('');
	let labelError = $state('');
	let saving = $state(false);
	let confirming = $state<string | null>(null);
	let flashed = $state<string | null>(null);
	let confirmTimer: ReturnType<typeof setTimeout>;
	let flashTimer: ReturnType<typeof setTimeout>;
	let revealedSeq = 0;
	let disposed = false;
	const rows = $derived(buildBookmarks(controller.bookmarks, controller.file?.id ?? -1));
	const currentPageBookmark = $derived(pageBookmark(rows.current, controller.file?.id ?? -1, ctx.view.page));
	const busy = $derived(saving || controller.busy);

	onDestroy(() => {
		disposed = true;
		clearTimeout(confirmTimer);
		clearTimeout(flashTimer);
	});

	async function togglePage() {
		if (busy) return;
		if (currentPageBookmark) {
			await controller.removeBookmark(currentPageBookmark, { confirm: false });
		} else {
			const page = ctx.view.page;
			await controller.addBookmark({
				label: m['rp8.page']({ page }),
				at: { locator: { type: 'pdf', page }, fraction: toFraction(page, 0, ctx.view.pageCount) }
			});
		}
	}

	async function jump(bookmark: Bookmark) {
		if (await controller.jumpToBookmark(bookmark)) {
			if (!ctx.sidebar.docked) {
				ctx.sidebar.collapse();
				document.getElementById(tabId('bookmarks'))?.focus();
			}
		}
	}

	async function rename(bookmark: Bookmark) {
		editing = bookmark.id;
		value = bookmark.label;
		labelError = '';
		confirming = null;
		await tick();
		root?.querySelector<HTMLInputElement>('input')?.select();
	}

	function cancelRename() {
		if (saving) return;
		editing = null;
		labelError = '';
	}

	function focusEntry(id: string) {
		const button = [...(root?.querySelectorAll<HTMLButtonElement>('[data-bookmark-jump]') ?? [])]
			.find((element) => element.dataset.bookmarkJump === id);
		button?.focus({ preventScroll: true });
		return button;
	}

	async function saveLabel(bookmark: Bookmark) {
		if (busy) return;
		const result = validateBookmarkLabel(value);
		if (result.error) {
			labelError = result.error === 'length' ? m['rp8.label_invalid']() : m['ux6.limit']();
			return;
		}
		saving = true;
		try {
			if (await controller.updateBookmark(bookmark, { label: result.label })) {
				editing = null;
				labelError = '';
				await tick();
				if (!disposed) focusEntry(bookmark.id);
			}
		} finally {
			saving = false;
		}
	}

	async function remove(bookmark: Bookmark) {
		if (busy) return;
		if (confirming !== bookmark.id) {
			confirming = bookmark.id;
			clearTimeout(confirmTimer);
			confirmTimer = setTimeout(() => { confirming = null; }, 3000);
			return;
		}
		if (await controller.removeBookmark(bookmark, { confirm: false })) {
			clearTimeout(confirmTimer);
			confirming = null;
		}
	}

	$effect(() => {
		const target = ctx.sidebar.target;
		if (!ctx.sidebar.open || target?.kind !== 'bookmark' || target.seq === revealedSeq ||
			!rows.current.some((row) => row.id === target.id)) return;
		revealedSeq = target.seq;
		void tick().then(() => {
			if (disposed || !ctx.sidebar.open || ctx.sidebar.target?.seq !== target.seq) return;
			const button = focusEntry(target.id);
			button?.scrollIntoView({ block: 'nearest' });
			clearTimeout(flashTimer);
			flashed = target.id;
			flashTimer = setTimeout(() => { flashed = null; }, 1000);
		});
	});
</script>

<div bind:this={root} class="rp8-bookmarks">
	<div class="rp8-header">
		<p aria-live="polite">{m['rp8.count']({ count: rows.current.length })}</p>
		<button type="button" class="rp8-toggle" aria-pressed={!!currentPageBookmark} disabled={busy || !controller.ready} onclick={togglePage}>
			<Icon name="bookmark" />
			{currentPageBookmark ? m['rp8.remove_page']() : m['rp8.add_page']()}
		</button>
	</div>
	{#if controller.actionError}<p class="rp8-error" role="alert">{controller.actionError}</p>{/if}
	{#if !rows.current.length}<p class="rp8-empty">{m['rp8.empty']()}</p>{/if}
	<ul aria-label={m['rp4.bookmarks']()}>
		{#each rows.current as bookmark (bookmark.id)}
			<li class:rp8-flash={flashed === bookmark.id} data-bookmark-id={bookmark.id}>
				<div class="rp8-row">
					{#if editing === bookmark.id}
						<form onsubmit={(event) => { event.preventDefault(); void saveLabel(bookmark); }}>
							<input
								aria-label={m['rp8.label']()} aria-invalid={!!labelError}
								aria-describedby={labelError ? 'rp8-label-error' : undefined}
								bind:value readonly={saving} onblur={cancelRename}
								oninput={() => { labelError = ''; }}
								onkeydown={(event) => {
									if (event.key === 'Escape') {
										event.preventDefault();
										event.stopPropagation();
										cancelRename();
										void tick().then(() => focusEntry(bookmark.id));
									}
								}}
							/>
						</form>
					{:else}
						<button type="button" class="rp8-jump" data-bookmark-jump={bookmark.id} title={bookmark.label} onclick={() => jump(bookmark)}>
							<Icon name="bookmark" />
							<span class="rp8-label">{bookmark.label || m['rp8.page']({ page: bookmarkPage(bookmark)! })}</span>
							<span class="rp8-page">{m['rp8.page_short']({ page: bookmarkPage(bookmark)! })}</span>
						</button>
					{/if}
					<button type="button" class="rp8-action" aria-label={m['rp8.rename']({ label: bookmark.label })} title={m['rp8.rename']({ label: bookmark.label })} disabled={busy} onclick={() => rename(bookmark)}><Icon name="pencil" class="size-4" /></button>
					<button type="button" class="rp8-action" class:rp8-confirm={confirming === bookmark.id} aria-label={confirming === bookmark.id ? m['rp8.confirm_delete']({ label: bookmark.label }) : m['rp8.delete']({ label: bookmark.label })} title={m['rp8.delete']({ label: bookmark.label })} disabled={busy} onclick={() => remove(bookmark)}>
						{#if confirming === bookmark.id}{m['rp8.delete_question']()}{:else}<Icon name="trash" class="size-4" />{/if}
					</button>
				</div>
				{#if editing === bookmark.id && labelError}<p id="rp8-label-error" class="rp8-error" role="alert">{labelError}</p>{/if}
			</li>
		{/each}
	</ul>
	{#if rows.other.length}
		<h3 class="rp8-other">{m['rp8.other_files']()}</h3>
		<ul aria-label={m['rp8.other_files']()}>
			{#each rows.other as bookmark (bookmark.id)}
				<li class="rp8-row rp8-unavailable">
					<button type="button" class="rp8-jump" disabled title={m['ux6.unavailable']()}>
						<Icon name="bookmark" />
						<span class="rp8-label">{bookmark.label || m['ux6.unavailable']()}</span>
						{#if bookmarkPage(bookmark) !== null}<span class="rp8-page">{m['rp8.page_short']({ page: bookmarkPage(bookmark)! })}</span>{/if}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.rp8-bookmarks { padding: 8px; color: var(--shell-text); font-size: 13px; }
	.rp8-header { display: grid; gap: 8px; padding: 4px 0 12px; }
	.rp8-header p { margin: 0; font-size: 12px; }
	.rp8-toggle { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 36px; border: 1px solid var(--shell-border); border-radius: 4px; padding: 4px 8px; }
	.rp8-toggle[aria-pressed='true'] { box-shadow: inset 3px 0 #10b981; }
	ul { list-style: none; margin: 0; padding: 0; }
	.rp8-row { display: flex; align-items: center; height: 36px; min-width: 0; gap: 2px; }
	.rp8-jump { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; height: 36px; padding: 0 4px; text-align: left; }
	.rp8-jump :global(svg) { flex-shrink: 0; }
	.rp8-label { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex: 1; }
	.rp8-page { flex-shrink: 0; font-size: 12px; }
	.rp8-action { display: grid; place-items: center; min-width: 28px; height: 36px; padding: 0 4px; border-radius: 4px; }
	.rp8-confirm { background: #991b1b; color: white; }
	.rp8-flash { box-shadow: inset 0 0 0 2px #10b981; border-radius: 4px; }
	button:enabled { cursor: pointer; }
	button:enabled:hover { background-color: rgb(128 128 128 / 15%); }
	.rp8-confirm:enabled:hover { background: #7f1d1d; }
	button:focus-visible, input:focus-visible { outline: 2px solid #10b981; outline-offset: -2px; }
	button:disabled { cursor: default; }
	form { min-width: 0; flex: 1; }
	input { width: 100%; box-sizing: border-box; height: 30px; border: 1px solid var(--shell-border); border-radius: 4px; padding: 0 4px; background: var(--shell-surface); color: inherit; }
	.rp8-error { font-size: 12px; padding: 4px; }
	.rp8-empty { padding: 8px 4px; }
	.rp8-other { font-size: 12px; margin: 16px 4px 4px; }
	.rp8-unavailable { opacity: .7; }
</style>
