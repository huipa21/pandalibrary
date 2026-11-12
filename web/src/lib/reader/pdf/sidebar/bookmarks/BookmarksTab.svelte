<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import type { Bookmark } from '../../../types.js';
	import { getPdfReaderContext } from '../../context.js';
	import { formatPercent } from '../../progress.js';
	import { tabId } from '../SidebarRail.svelte';
	import { bookmarkPage, buildBookmarks, validateBookmarkLabel } from './bookmarks-model.js';

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
	const busy = $derived(saving || controller.busy);

	onDestroy(() => {
		disposed = true;
		clearTimeout(confirmTimer);
		clearTimeout(flashTimer);
	});

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

	function stamp(iso: string) {
		const date = new Date(iso);
		return Number.isFinite(date.getTime())
			? new Intl.DateTimeFormat(getLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(date)
			: iso;
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
	</div>
	{#if controller.actionError}<p class="rp8-error" role="alert">{controller.actionError}</p>{/if}
	{#if !rows.current.length}<p class="rp8-empty">{m['rp8.empty']()}</p>{/if}
	<ul aria-label={m['rp4.bookmarks']()}>
		{#each rows.current as bookmark (bookmark.id)}
			<li class="rp8-row" class:rp8-flash={flashed === bookmark.id} class:rp8-confirming={confirming === bookmark.id} data-bookmark-id={bookmark.id}>
					{#if editing === bookmark.id}
						<div class="rp8-editing">
							<div class="rp8-meta">
								<time datetime={bookmark.created_at} title={bookmark.created_at}>{stamp(bookmark.created_at)}</time>
								<span class="rp8-progress">{formatPercent(bookmark.position, getLocale())}</span>
							</div>
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
						</div>
					{:else}
						<button type="button" class="rp8-jump" data-bookmark-jump={bookmark.id} title={bookmark.label} onclick={() => jump(bookmark)}>
							<span class="rp8-meta">
								<time datetime={bookmark.created_at} title={bookmark.created_at}>{stamp(bookmark.created_at)}</time>
								<span class="rp8-progress">{formatPercent(bookmark.position, getLocale())}</span>
							</span>
							<span class="rp8-label">{bookmark.label || m['rp8.page']({ page: bookmarkPage(bookmark)! })}</span>
						</button>
					{/if}
					<button type="button" class="rp8-action rp8-rename" aria-label={m['rp8.rename']({ label: bookmark.label })} title={m['rp8.rename']({ label: bookmark.label })} disabled={busy} onclick={() => rename(bookmark)}><Icon name="pencil" class="size-4" /></button>
					<button type="button" class="rp8-action rp8-delete" class:rp8-confirm={confirming === bookmark.id} aria-label={confirming === bookmark.id ? m['rp8.confirm_delete']({ label: bookmark.label }) : m['rp8.delete']({ label: bookmark.label })} title={m['rp8.delete']({ label: bookmark.label })} disabled={busy} onclick={() => remove(bookmark)}>
						{#if confirming === bookmark.id}{m['rp8.delete_question']()}{:else}<Icon name="trash" class="size-4" />{/if}
					</button>
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
						<span class="rp8-meta">
							<time datetime={bookmark.created_at} title={bookmark.created_at}>{stamp(bookmark.created_at)}</time>
							<span class="rp8-progress">{formatPercent(bookmark.position, getLocale())}</span>
						</span>
						<span class="rp8-label">{bookmark.label || m['ux6.unavailable']()}</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.rp8-bookmarks { padding: 8px; color: var(--shell-text); font-size: 13px; }
	.rp8-header { padding: 4px 0 12px; }
	.rp8-header p { margin: 0; font-size: 12px; }
	ul { list-style: none; margin: 0; padding: 0; }
	.rp8-row { --rp8-delete-width: 28px; display: grid; grid-template-columns: minmax(0, 1fr) 28px var(--rp8-delete-width); grid-template-rows: 28px auto; min-width: 0; margin-bottom: 4px; }
	.rp8-confirming { --rp8-delete-width: 48px; }
	.rp8-jump, .rp8-editing { display: grid; grid-template-rows: 28px minmax(24px, auto); grid-column: 1 / -1; grid-row: 1 / 3; min-width: 0; padding: 0 4px 4px; text-align: left; border-radius: 4px; }
	.rp8-meta { display: flex; align-items: center; min-width: 0; gap: 4px; padding-right: calc(28px + var(--rp8-delete-width)); font-size: 11px; font-variant-numeric: tabular-nums; }
	time { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
	.rp8-progress { flex-shrink: 0; margin-left: auto; }
	.rp8-label { display: block; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; align-self: center; }
	.rp8-action { z-index: 1; display: grid; place-items: center; grid-row: 1; min-width: 28px; height: 28px; padding: 0 4px; border-radius: 4px; }
	.rp8-rename { grid-column: 2; }
	.rp8-delete { grid-column: 3; }
	.rp8-confirm { background: #991b1b; color: white; }
	.rp8-flash { box-shadow: inset 0 0 0 2px #10b981; border-radius: 4px; }
	button:enabled { cursor: pointer; }
	button:enabled:hover { background-color: rgb(128 128 128 / 15%); }
	.rp8-confirm:enabled:hover { background: #7f1d1d; }
	button:focus-visible, input:focus-visible { outline: 2px solid #10b981; outline-offset: -2px; }
	button:disabled { cursor: default; }
	form { min-width: 0; }
	input { width: 100%; box-sizing: border-box; height: 30px; border: 1px solid var(--shell-border); border-radius: 4px; padding: 0 4px; background: var(--shell-surface); color: inherit; }
	.rp8-error { font-size: 12px; padding: 4px; }
	.rp8-row > .rp8-error { grid-column: 1 / -1; }
	.rp8-empty { padding: 8px 4px; }
	.rp8-other { font-size: 12px; margin: 16px 4px 4px; }
	.rp8-unavailable { opacity: .7; }
	.rp8-unavailable .rp8-meta { padding-right: 0; }
</style>
