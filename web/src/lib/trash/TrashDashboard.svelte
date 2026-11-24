<script lang="ts">
	import { showLoadingAfterDelay } from '#lib/ui/deferred.js';
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import SearchField from '#lib/search/SearchField.svelte';
	import Icon from '#lib/bookview/Icon.svelte';
	import { filterControlClass, controlButtonClass, iconControlClass, controlIconClass } from '#lib/catalog/filter-styles.js';
	import { confirmAction } from '#lib/shell/confirmation.js';
	import { requestErrorKind } from '#lib/paging/errors.js';
	import { ApiError } from '#lib/api/client.js';
	import { notifyBooksChanged } from '#lib/catalog/events.js';
	import { notifyWordbooksChanged } from '#lib/wordbooks/api.js';
	import { TrashState } from './TrashState.svelte.js';
	import { trashKey, type TrashAction, type TrashFilter, type TrashReference, type TrashType } from './api.js';

	const trash = new TrashState();
	let draft = $state('');
	let notice = $state('');
	let selecting = $state(false);
	let lastAction = $state<{ action: TrashAction; items: TrashReference[] } | null>(null);
	const locale = $derived(getLocale());
	const disabled = $derived(trash.loading || trash.busy);
	const reviewRestoreConflict = $derived(lastAction?.action === 'restore' && trash.actionError instanceof ApiError
		&& trash.actionError.status === 409 && trash.actionError.problem?.detail === 'a review already exists for this book and user');
	const types: TrashType[] = ['book', 'file', 'wordbook', 'annotation'];
	const labels = {
		book: m['trash.book'],
		file: m['trash.file'],
		wordbook: m['trash.wordbook'],
		annotation: m['trash.annotation']
	};
	const groups = $derived.by(() => {
		const grouped = new Map<string, typeof trash.items>();
		for (const item of trash.items) {
			const month = item.deletedAt.slice(0, 7);
			grouped.set(month, [...(grouped.get(month) ?? []), item]);
		}
		return [...grouped].sort(([a], [b]) => b.localeCompare(a));
	});

	onMount(() => void trash.load());
	onDestroy(() => trash.dispose());

	function search(event?: SubmitEvent) {
		event?.preventDefault();
		notice = '';
		void trash.load(draft);
	}

	function filter(event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value as TrashFilter;
		notice = '';
		void trash.load(draft, value);
	}

	function toggleSelection() {
		selecting = !selecting;
		if (!selecting) trash.selected = [];
	}

	async function act(action: TrashAction, items: readonly TrashReference[]) {
		if (!items.length || disabled) return;
		const targets = items.map(({ id, type }) => ({ id, type }));
		if (action === 'delete' && !await confirmAction(m['trash.confirm_delete']({ count: targets.length }))) return;
		lastAction = { action, items: targets };
		notice = '';
		if (await trash.act(action, targets)) {
			notice = action === 'restore' ? m['trash.restored']({ count: targets.length }) : m['trash.deleted']({ count: targets.length });
			if (targets.some((item) => item.type === 'book' || item.type === 'file')) notifyBooksChanged();
			if (targets.some((item) => item.type === 'wordbook')) notifyWordbooksChanged();
		}
	}

	function dateLabel(value: string, month = false): string {
		const date = new Date(month ? `${value}-01T00:00:00Z` : value);
		if (Number.isNaN(date.getTime())) return value;
		return new Intl.DateTimeFormat(locale, month
			? { month: 'long', year: 'numeric', timeZone: 'UTC' }
			: { dateStyle: 'medium' }).format(date);
	}
</script>

<svelte:head>
	<title>{m['trash.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="trash-layout" aria-labelledby="trash-heading">
	<section class="trash-container card">
		<header class="trash-toolbar">
			<h1 id="trash-heading">{m['trash.title']()}</h1>
			<form role="search" aria-label={m['trash.search']()} onsubmit={search}>
				<select class={filterControlClass} aria-label={m['trash.filter']()} value={trash.filter} onchange={filter} {disabled}>
					<option value="">{m['trash.all']()}</option>
					{#each types as type (type)}<option value={type}>{labels[type]()}</option>{/each}
				</select>
				<SearchField
					id="trash-search" name="search" label={m['trash.search']()} placeholder={m['trash.search']()}
					class="min-w-40 flex-1" bind:value={draft} {disabled}
					clear={trash.search !== '' && draft.trim() === trash.search}
					onclear={() => { draft = ''; search(); }}
				/>
				<button type="button" class={iconControlClass} aria-label={m['trash.multi_select']()} title={m['trash.multi_select']()}
					aria-pressed={selecting} {disabled} onclick={toggleSelection}>
					<Icon name="check" class={controlIconClass} />
				</button>
				{#if selecting && trash.selectedItems.length}
					<span class="muted selection-count">{m['trash.selected']({ count: trash.selectedItems.length })}</span>
					<button type="button" class={iconControlClass} aria-label={m['trash.clear_selection']()} title={m['trash.clear_selection']()}
						{disabled} onclick={() => trash.selected = []}><Icon name="x" class={controlIconClass} /></button>
					<button type="button" class={iconControlClass} aria-label={m['trash.restore_selected']()} title={m['trash.restore_selected']()}
						{disabled} onclick={() => act('restore', trash.selectedItems)}><Icon name="undo" class={controlIconClass} /></button>
					<button type="button" class="{iconControlClass} danger" aria-label={m['trash.delete_selected']()} title={m['trash.delete_selected']()}
						{disabled} onclick={() => act('delete', trash.selectedItems)}><Icon name="trash" class={controlIconClass} /></button>
				{/if}
			</form>
		</header>

		<div class="trash-content" aria-busy={disabled}>
			{#if trash.actionError}
				<div class="error" role="alert">
					<p>{reviewRestoreConflict ? m['trash.review_restore_conflict']() : m['trash.action_error']()}</p>
					{#if requestErrorKind(trash.actionError) === 'unauthorized'}
						<a href="/login">{m['stats.sign_in']()}</a>
					{:else if lastAction}
						<button type="button" class={controlButtonClass} {disabled} onclick={() => lastAction && act(lastAction.action, lastAction.items)}>{m['trash.retry']()}</button>
					{/if}
				</div>
			{/if}
			{#if notice}<p class="status" role="status">{notice}</p>{/if}
			{#if trash.busy}<p class="status" role="status">{m['trash.working']()}</p>{/if}
			{#if trash.error}
				<div class="error" role="alert">
					<p>{m['trash.load_error']()}</p>
					{#if requestErrorKind(trash.error) === 'unauthorized'}
						<a href="/login">{m['stats.sign_in']()}</a>
					{:else}
						<button type="button" class={controlButtonClass} onclick={() => trash.load()}>{m['trash.retry']()}</button>
					{/if}
				</div>
			{:else if trash.loading}
				<p use:showLoadingAfterDelay class="status" role="status">{m['trash.loading']()}</p>
			{:else if trash.items.length === 0}
				<p class="status" role="status">{trash.search || trash.filter ? m['trash.no_results']() : m['trash.empty']()}</p>
			{:else}
				{#each groups as [month, items] (month)}
					<section class="trash-month" aria-labelledby={`trash-month-${month}`}>
						<h2 id={`trash-month-${month}`}>{dateLabel(month, true)}</h2>
						<ul>
							{#each items as item (trashKey(item))}
								<li class="trash-row" class:selection-mode={selecting} class:selected={trash.has(item)} data-testid="trash-row">
									{#if selecting}
										<input type="checkbox" aria-label={m['trash.select']({ title: item.title })} checked={trash.has(item)}
											{disabled} onchange={() => trash.toggle(item)} />
									{/if}
									<time datetime={item.deletedAt} title={m['trash.deleted_at']({ date: dateLabel(item.deletedAt) })}>{dateLabel(item.deletedAt)}</time>
									<div class="item-info">
										<p class="item-title">{item.title}</p>
										{#if item.subtitle}<p class="subtitle">{item.subtitle}</p>{/if}
										<span class="type-badge">{labels[item.type]()}</span>
									</div>
									<div class="row-actions">
										<button type="button" class={iconControlClass} aria-label={m['trash.restore']()} title={m['trash.restore']()}
											{disabled} onclick={() => act('restore', [item])}><Icon name="undo" class={controlIconClass} /></button>
										<button type="button" class="{iconControlClass} danger" aria-label={m['trash.delete']()} title={m['trash.delete']()}
											{disabled} onclick={() => act('delete', [item])}><Icon name="trash" class={controlIconClass} /></button>
									</div>
								</li>
							{/each}
						</ul>
					</section>
				{/each}
			{/if}
		</div>
	</section>
	<aside class="trash-summary card" aria-labelledby="trash-summary-heading">
		<h2 id="trash-summary-heading">{m['trash.summary']()}</h2>
		<p class="muted">{m['trash.help']()}</p>
		{#if !trash.loading && !trash.error}
			<p>{m['trash.results']({ count: trash.items.length })}</p>
			<dl>
				{#each types as type (type)}
					<div><dt>{labels[type]()}</dt><dd>{trash.items.filter((item) => item.type === type).length}</dd></div>
				{/each}
			</dl>
		{/if}
	</aside>
</section>

<style>
	.trash-layout { display: grid; grid-template-columns: minmax(0, 1fr) 20rem; gap: 1.25rem; align-items: start; color: var(--shell-text); }
	.trash-container { min-width: 0; overflow: hidden; }
	.trash-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; padding: .75rem 1rem; border-bottom: 1px solid var(--shell-border); }
	h1, .trash-summary h2 { font-size: .85rem; font-weight: 700; }
	form { display: flex; flex: 1; flex-wrap: wrap; min-width: 0; align-items: center; gap: .75rem; }
	select { max-width: 100%; }
	.selection-count { font-size: .75rem; }
	input[type="checkbox"] { width: 1rem; height: 1rem; accent-color: var(--shell-active); flex-shrink: 0; }
	input:focus-visible { outline: 2px solid var(--shell-active); outline-offset: 3px; }
	.trash-content { padding: 0 1rem; }
	.trash-month { margin-bottom: 1.5rem; }
	.trash-month h2 { padding: .75rem 0; font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; border-bottom: 1px solid var(--shell-border); }
	.trash-row { display: grid; grid-template-columns: 5.3rem minmax(0, 1fr) auto; gap: .8rem; align-items: center; padding: .85rem .65rem; border-bottom: 1px solid var(--shell-border); }
	.trash-row.selection-mode { grid-template-columns: 1rem 5.3rem minmax(0, 1fr) auto; }
	.trash-row:hover, .trash-row.selected { background: var(--shell-hover); }
	time { font-size: .7rem; color: var(--shell-muted); }
	.item-info { min-width: 0; }
	.item-title { font-size: .85rem; font-weight: 600; overflow-wrap: anywhere; }
	.subtitle { font-size: .75rem; color: var(--shell-muted); margin: .15rem 0 .35rem; overflow-wrap: anywhere; white-space: pre-wrap; }
	.type-badge { display: inline-block; font-size: .65rem; border: 1px solid var(--shell-border); border-radius: 999px; padding: 0 .4rem; }
	.row-actions { display: flex; flex-wrap: wrap; justify-content: end; gap: .5rem; }
	.danger { color: var(--shell-danger, #b91c1c); }
	.muted { color: var(--shell-muted); }
	.status { padding: 1.25rem; text-align: center; font-size: .85rem; }
	.error { border: 1px solid #e57373; border-radius: .5rem; padding: 1rem; margin: 1rem 0; font-size: .85rem; }
	.error button, .error a { margin-top: .5rem; }
	.trash-summary { padding: 1rem; font-size: .85rem; }
	.trash-summary p { margin-top: .75rem; }
	dl { margin-top: 1rem; border-top: 1px solid var(--shell-border); }
	dl div { display: flex; justify-content: space-between; gap: 1rem; padding: .6rem 0; border-bottom: 1px solid var(--shell-border); }
	dt { color: var(--shell-muted); }
	dd { font-variant-numeric: tabular-nums; }
	@media (max-width: 75rem) { .trash-layout { grid-template-columns: minmax(0, 1fr) 19rem; } }
	@media (max-width: 60rem) { .trash-layout { grid-template-columns: minmax(0, 1fr); } .trash-summary { width: 100%; max-width: 36rem; } }
	@media (max-width: 30rem) {
		.trash-toolbar { padding: .75rem; }
		h1 { width: 100%; }
		.trash-content { padding: 0 .75rem; }
		.trash-row { grid-template-columns: minmax(0, 1fr) auto; gap: .5rem; padding: .75rem .25rem; }
		time { grid-column: 1 / -1; }
		.trash-row.selection-mode { grid-template-columns: 1rem minmax(0, 1fr) auto; }
		.selection-mode input { grid-row: 1 / 3; }
		.selection-mode time { grid-column: 2 / -1; }
		.selection-mode .item-info { grid-column: 2; }
	}
</style>
