<script lang="ts">
	import { onMount, tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { ApiError } from '#lib/api/client.js';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { SyncError } from '#lib/reader/api.js';
	import { getShelf, listShelves } from '#lib/shelves/api.js';
	import type { Shelf } from '#lib/shelves/types.js';
	import { offlineStatus } from '#lib/sync/client.js';
	import { uniquePages } from './api.js';
	import DashboardRow from './DashboardRow.svelte';
	import { sectionLabel, shelfLabel, type ShelfState } from './labels.js';
	import {
		BUILT_IN_SECTIONS, DEFAULT_SECTIONS, isBuiltInSection, LayoutTooLargeError, moveSection,
		parseSectionId, shelfId, shelfSection, type ParsedLayout, type SectionId
	} from './layout.js';
	import { LayoutNotSyncedError, readDashboardLayout, saveDashboardLayout } from './storage.js';

	let { account }: { account: number } = $props();
	let layout = $state<ParsedLayout | null>(null);
	let loading = $state(true);
	let loadError = $state('');
	let notice = $state('');
	let actionError = $state('');
	let conflict = $state(false);
	let saving = $state(false);
	let configOpen = $state(false);
	let configDialog = $state<HTMLDialogElement | null>(null);
	let configHeading = $state<HTMLHeadingElement | null>(null);
	let gear = $state<HTMLButtonElement | null>(null);
	let draft = $state<SectionId[]>([]);
	let selectedBuiltin = $state('');
	let selectedShelf = $state('');
	let shelfError = $state('');
	let shelfBusy = $state(false);
	let shelfStates = $state<Record<string, ShelfState>>({});
	let requestVersion = 0;
	let configVersion = 0;
	let metadataVersion = 0;
	let mounted = true;
	let deferredRefresh = false;
	const shelfPager = new CursorPager<Shelf>();
	const choices = $derived.by(() => {
		const seen = new Set<number>();
		return shelfPager.items.filter((shelf) => {
			if (!Number.isSafeInteger(shelf.id) || shelf.id < 1 || seen.has(shelf.id)) return false;
			seen.add(shelf.id);
			return !draft.includes(shelfSection(shelf.id));
		});
	});
	const availableBuiltins = $derived(BUILT_IN_SECTIONS.filter((id) => !draft.includes(id)));

	onMount(() => {
		void refreshLayout();
		let wasSyncing = false;
		const unsubscribe = offlineStatus.subscribe((status) => {
			if (status.account !== account) return;
			if (status.syncing) {
				wasSyncing = true;
			} else if (wasSyncing) {
				wasSyncing = false;
				refreshAfterSync();
			}
		});
		const onSyncMessage = (event: MessageEvent<unknown>) => {
			if (event.data === 'pandalibrary-sync-complete') refreshAfterSync();
		};
		const onShelvesChanged = () => {
			if (configOpen) {
				void refreshShelfOptions();
				void refreshDraftShelfStates();
			}
		};
		navigator.serviceWorker?.addEventListener('message', onSyncMessage);
		window.addEventListener('pandalibrary-shelves-changed', onShelvesChanged);
		return () => {
			mounted = false;
			requestVersion += 1;
			configVersion += 1;
			metadataVersion += 1;
			unsubscribe();
			shelfPager.dispose();
			navigator.serviceWorker?.removeEventListener('message', onSyncMessage);
			window.removeEventListener('pandalibrary-shelves-changed', onShelvesChanged);
		};
	});

	function refreshAfterSync() {
		if (saving || configOpen) {
			deferredRefresh = true;
		} else {
			void refreshLayout(false);
		}
	}

	async function refreshLayout(showLoading = true) {
		const version = ++requestVersion;
		if (showLoading) loading = true;
		try {
			const result = await readDashboardLayout(account);
			if (!mounted || version !== requestVersion) return;
			layout = result.layout;
			conflict = result.conflict;
			loadError = '';
		} catch (error) {
			if (!mounted || version !== requestVersion) return;
			console.error('Could not load dashboard settings', error);
			loadError = error instanceof LayoutNotSyncedError
				? m['ux5.layout_not_synced']()
				: m['ux5.layout_failed']();
		} finally {
			if (mounted && version === requestVersion) loading = false;
		}
	}

	function setShelfState(id: SectionId, state: ShelfState) {
		shelfStates = { ...shelfStates, [id]: state };
	}

	async function refreshDraftShelfStates() {
		const version = ++metadataVersion;
		const sections = draft.filter((id) => shelfId(id) !== null);
		for (const id of sections) setShelfState(id, { status: 'loading' });
		let index = 0;
		async function worker() {
			while (index < sections.length) {
				const id = sections[index++];
				const numericId = shelfId(id);
				if (numericId === null) continue;
				try {
					const shelf = await getShelf(numericId);
					if (!mounted || version !== metadataVersion) return;
					setShelfState(id, { status: 'ready', shelf });
				} catch (error) {
					if (!mounted || version !== metadataVersion) return;
					console.error('Could not check a dashboard shelf', error);
					setShelfState(id, {
						status: error instanceof ApiError && (error.status === 403 || error.status === 404)
							? 'unavailable' : 'error'
					});
				}
			}
		}
		await Promise.all(Array.from({ length: Math.min(4, sections.length) }, () => worker()));
	}

	async function refreshShelfOptions() {
		const version = configVersion;
		await shelfPager.reset(uniquePages((cursor, signal) => listShelves({ cursor, signal, limit: 30 })));
		if (!mounted || !configOpen || version !== configVersion) return;
		if (shelfPager.status === 'error') console.error('Could not load dashboard shelf choices', shelfPager.error);
	}

	async function moreShelves() {
		await shelfPager.loadMore();
		if (shelfPager.moreError) console.error('Could not load more dashboard shelves', shelfPager.moreError);
	}

	async function openConfiguration() {
		if (!layout?.valid || saving) return;
		configVersion += 1;
		draft = [...layout.sections];
		selectedBuiltin = '';
		selectedShelf = '';
		shelfError = '';
		actionError = '';
		configOpen = true;
		void refreshShelfOptions();
		void refreshDraftShelfStates();
		await tick();
		if (!mounted || !configOpen || !configDialog) return;
		configDialog.showModal();
		configHeading?.focus();
	}

	function closeConfiguration() {
		if (saving) return;
		configDialog?.close();
		configOpen = false;
		configVersion += 1;
		shelfBusy = false;
		metadataVersion += 1;
		shelfPager.dispose();
		gear?.focus();
		if (deferredRefresh) {
			deferredRefresh = false;
			void refreshLayout(false);
		}
	}

	function cancelConfiguration(event: Event) {
		event.preventDefault();
		closeConfiguration();
	}

	function addBuiltIn() {
		const id = parseSectionId(selectedBuiltin);
		if (!id || !isBuiltInSection(id) || draft.includes(id)) return;
		draft = [...draft, id];
		selectedBuiltin = '';
	}

	async function addShelf() {
		const id = Number(selectedShelf);
		if (!Number.isSafeInteger(id) || id < 1 || shelfBusy) return;
		const section = shelfSection(id);
		if (draft.includes(section)) return;
		const version = configVersion;
		shelfBusy = true;
		shelfError = '';
		try {
			const shelf = await getShelf(id);
			if (!mounted || !configOpen || version !== configVersion) return;
			setShelfState(section, { status: 'ready', shelf });
			draft = [...draft, section];
			selectedShelf = '';
		} catch (error) {
			if (!mounted || !configOpen || version !== configVersion) return;
			console.error('Could not add the selected dashboard shelf', error);
			shelfError = m['ux5.shelf_selection_failed']();
			selectedShelf = '';
			void refreshShelfOptions();
		} finally {
			if (mounted && version === configVersion) shelfBusy = false;
		}
	}

	async function persist(sections: readonly SectionId[], close = false) {
		if (saving) return;
		requestVersion += 1;
		saving = true;
		actionError = '';
		notice = '';
		try {
			const outcome = await saveDashboardLayout(account, sections);
			if (!mounted) return;
			layout = { valid: true, sections: [...sections], missing: false };
			notice = outcome === 'applied' ? m['ux5.saved']() : m['ux5.queued']();
			if (close) {
				saving = false;
				closeConfiguration();
			}
		} catch (error) {
			if (!mounted) return;
			console.error('Could not save dashboard settings', error);
			if (error instanceof SyncError) {
				conflict = true;
				actionError = m['ux5.save_conflict']();
			} else if (error instanceof LayoutTooLargeError) {
				actionError = m['ux5.too_large']();
			} else {
				actionError = m['ux5.save_failed']();
			}
		} finally {
			if (mounted) saving = false;
		}
	}

	function removeUnavailable(id: SectionId) {
		if (layout?.valid) void persist(layout.sections.filter((section) => section !== id));
	}
</script>

<section class="space-y-6" aria-labelledby="dashboard-heading" data-dashboard>
	<h1 id="dashboard-heading" class="sr-only">{m['ux1.dashboard.title']()}</h1>
	<div class="flex justify-end">
		<button bind:this={gear} class="grid size-10 place-items-center rounded-md border border-slate-300 text-slate-700 hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:opacity-50" aria-label={m['ux5.configure']()} title={m['ux5.configure']()} disabled={!layout?.valid || loading || saving} onclick={() => void openConfiguration()}>
			<svg aria-hidden="true" viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="m19.4 15 1.1 1.9-2 2-1.9-1.1a8.6 8.6 0 0 1-2 .8l-.5 2.2h-2.8l-.5-2.2a8.6 8.6 0 0 1-2-.8l-1.9 1.1-2-2L6 15a8.6 8.6 0 0 1-.8-2L3 12.5V9.7l2.2-.5a8.6 8.6 0 0 1 .8-2L4.9 5.3l2-2 1.9 1.1a8.6 8.6 0 0 1 2-.8l.5-2.1h2.8l.5 2.1a8.6 8.6 0 0 1 2 .8l1.9-1.1 2 2-1.1 1.9a8.6 8.6 0 0 1 .8 2l2.1.5v2.8l-2.1.5a8.6 8.6 0 0 1-.8 2Z" /></svg>
		</button>
	</div>

	{#if notice}<p class="rounded-md bg-emerald-50 p-3 text-sm text-emerald-900" role="status">{notice}</p>{/if}
	{#if conflict}
		<div class="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="alert">
			<p>{m['ux5.conflict']()}</p>
			<a class="font-medium underline focus-visible:outline-2" href="/settings">{m['ux5.review_conflicts']()}</a>
		</div>
	{/if}
	{#if actionError && !configOpen}
		<p class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{actionError}</p>
	{/if}
	{#if loadError}
		<div class="space-y-2 rounded-md border border-red-200 bg-red-50 p-4 text-red-800" role="alert">
			<p>{loadError}</p>
			<button class="font-medium underline focus-visible:outline-2" onclick={() => void refreshLayout()}>{m['ux5.retry']()}</button>
		</div>
	{/if}

	{#if loading && !layout}
		<p class="text-slate-600" role="status">{m['ux5.layout_loading']()}</p>
	{:else if layout && !layout.valid}
		<div class="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950" role="alert">
			<p>{m['ux5.layout_invalid']()}</p>
			<button class="rounded-md border border-amber-700 px-3 py-2 text-sm font-medium focus-visible:outline-2 disabled:opacity-60" disabled={saving} onclick={() => void persist(DEFAULT_SECTIONS)}>{m['ux5.reset']()}</button>
		</div>
	{:else if layout?.valid}
		{#if layout.sections.length === 0}
			<div class="space-y-2 rounded-2xl border border-slate-200 bg-white p-6">
				<h2 class="text-lg font-semibold">{m['ux5.empty_dashboard']()}</h2>
				<p class="text-slate-600">{m['ux5.empty_dashboard_help']()}</p>
			</div>
		{:else}
			<div class="space-y-5">
				{#each layout.sections as id (id)}
					<DashboardRow {id} {account} removing={saving} onShelfState={setShelfState} onRemove={removeUnavailable} />
				{/each}
			</div>
		{/if}
	{/if}
</section>

{#if configOpen}
	<dialog bind:this={configDialog} oncancel={cancelConfiguration} aria-labelledby="dashboard-config-title" class="fixed inset-0 m-auto max-h-[85dvh] w-[min(94vw,42rem)] overflow-y-auto rounded-2xl bg-white p-5 text-slate-950 shadow-2xl sm:p-6">
		<div class="space-y-5">
			<header>
				<h2 bind:this={configHeading} id="dashboard-config-title" tabindex="-1" class="text-xl font-semibold focus:outline-none">{m['ux5.configure']()}</h2>
				<p class="mt-1 text-sm text-slate-600">{m['ux5.config_description']()}</p>
			</header>
			{#if actionError}
				<p class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{actionError}</p>
			{/if}
			<section aria-labelledby="dashboard-config-sections" class="space-y-3">
				<h3 id="dashboard-config-sections" class="font-semibold">{m['ux5.sections']()}</h3>
				{#if draft.length}
					<ol class="space-y-2">
						{#each draft as id, index (id)}
							{@const label = sectionLabel(id, shelfStates[id])}
							<li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3" data-config-section={id}>
								<span class="min-w-0 break-words font-medium">{label}</span>
								<div class="flex gap-2">
									<button class="rounded border border-slate-300 px-2 py-1 focus-visible:outline-2 disabled:opacity-40" aria-label={m['ux5.move_up']({ section: label })} disabled={saving || index === 0} onclick={() => (draft = moveSection(draft, id, -1))}>&uarr;</button>
									<button class="rounded border border-slate-300 px-2 py-1 focus-visible:outline-2 disabled:opacity-40" aria-label={m['ux5.move_down']({ section: label })} disabled={saving || index === draft.length - 1} onclick={() => (draft = moveSection(draft, id, 1))}>&darr;</button>
									<button class="rounded border border-red-300 px-2 py-1 text-red-800 focus-visible:outline-2 disabled:opacity-40" aria-label={m['ux5.remove']({ section: label })} disabled={saving} onclick={() => (draft = draft.filter((section) => section !== id))}>{m['ux5.remove']({ section: label })}</button>
								</div>
							</li>
						{/each}
					</ol>
				{:else}
					<p class="text-sm text-slate-600">{m['ux5.empty_draft']()}</p>
				{/if}
			</section>

			<div class="space-y-2">
				<label for="dashboard-builtin" class="block text-sm font-medium">{m['ux5.select_builtin']()}</label>
				<div class="flex flex-wrap gap-2">
					<select id="dashboard-builtin" bind:value={selectedBuiltin} disabled={saving || !availableBuiltins.length} class="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-60">
						<option value="">{m['ux5.select_placeholder']()}</option>
						{#each availableBuiltins as id}<option value={id}>{sectionLabel(id)}</option>{/each}
					</select>
					<button class="rounded-md border border-emerald-700 px-3 py-2 text-sm font-medium text-emerald-800 focus-visible:outline-2 disabled:opacity-40" disabled={saving || !selectedBuiltin} onclick={addBuiltIn}>{m['ux5.add_builtin']()}</button>
				</div>
			</div>

			<div class="space-y-2">
				<label for="dashboard-shelf" class="block text-sm font-medium">{m['ux5.select_shelf']()}</label>
				<div class="flex flex-wrap gap-2">
					<select id="dashboard-shelf" bind:value={selectedShelf} disabled={saving || shelfBusy || !choices.length} class="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-60">
						<option value="">{m['ux5.select_placeholder']()}</option>
						{#each choices as shelf (shelf.id)}<option value={String(shelf.id)}>{shelfLabel(shelf)}</option>{/each}
					</select>
					<button class="rounded-md border border-emerald-700 px-3 py-2 text-sm font-medium text-emerald-800 focus-visible:outline-2 disabled:opacity-40" disabled={saving || shelfBusy || !selectedShelf} onclick={() => void addShelf()}>{m['ux5.add_shelf']()}</button>
				</div>
				{#if shelfError}<p class="text-sm text-red-800" role="alert">{shelfError}</p>{/if}
				{#if shelfPager.status === 'loading'}
					<p class="text-sm text-slate-600" role="status">{m['ux5.shelves_loading']()}</p>
				{:else if shelfPager.status === 'error' || shelfPager.moreError}
					<div class="flex flex-wrap items-center gap-2 text-sm text-red-800" role="alert">
						<p>{m['ux5.shelves_failed']()}</p>
						<button class="font-medium underline focus-visible:outline-2" onclick={() => void refreshShelfOptions()}>{m['ux5.shelves_retry']()}</button>
					</div>
				{:else if !choices.length && !shelfPager.hasMore}
					<p class="text-sm text-slate-600">{m['ux5.shelves_empty']()}</p>
				{/if}
				{#if shelfPager.hasMore}
					<button class="text-sm font-medium text-emerald-800 underline focus-visible:outline-2 disabled:opacity-50" disabled={saving || shelfPager.loadingMore} onclick={() => void moreShelves()}>{m['ux5.shelves_more']()}</button>
				{/if}
			</div>

			<div class="flex flex-wrap justify-end gap-3 border-t border-slate-200 pt-4">
				<button class="rounded-md border border-slate-300 px-4 py-2 font-medium focus-visible:outline-2 disabled:opacity-50" disabled={saving} onclick={closeConfiguration}>{m['ux5.cancel']()}</button>
				<button class="rounded-md bg-emerald-700 px-4 py-2 font-medium text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:opacity-50" disabled={saving || shelfBusy} onclick={() => void persist(draft, true)}>{saving ? m['ux5.saving']() : m['ux5.save']()}</button>
			</div>
		</div>
	</dialog>
{/if}

<style>
	dialog::backdrop {
		background: rgb(15 23 42 / 0.6);
	}
</style>
