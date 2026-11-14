<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { ApiError } from '#lib/api/client.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import { SyncError } from '#lib/reader/api.js';
	import { getShelf } from '#lib/shelves/api.js';
	import { offlineStatus } from '#lib/sync/client.js';
	import { filterControlClass } from '#lib/catalog/filter-styles.js';
	import { flip } from 'svelte/animate';
	import { dashboardConfigure } from './configure.svelte.js';
	import DashboardRow from './DashboardRow.svelte';
	import { sectionLabel, type ShelfState } from './labels.js';
	import {
		BUILT_IN_SECTIONS, DEFAULT_SECTIONS, isBuiltInSection, LayoutTooLargeError, moveSection,
		moveSectionTo, parseSectionId, shelfId, type ParsedLayout, type SectionId
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
	let draft = $state<SectionId[]>([]);
	let selectedBuiltin = $state('');
	let dragging = $state<SectionId | null>(null);
	let sectionList = $state<HTMLOListElement | null>(null);
	let shelfStates = $state<Record<string, ShelfState>>({});
	let requestVersion = 0;
	let configVersion = 0;
	let metadataVersion = 0;
	let mounted = true;
	let deferredRefresh = false;
	const availableBuiltins = $derived(BUILT_IN_SECTIONS.filter((id) => !draft.includes(id)));

	$effect(() => {
		if (!dashboardConfigure.pending || loading || saving) return;
		dashboardConfigure.pending = false;
		untrack(() => void openConfiguration());
	});

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
			if (configOpen) void refreshDraftShelfStates();
		};
		navigator.serviceWorker?.addEventListener('message', onSyncMessage);
		window.addEventListener('pandalibrary-shelves-changed', onShelvesChanged);
		return () => {
			mounted = false;
			requestVersion += 1;
			configVersion += 1;
			metadataVersion += 1;
			unsubscribe();
			endDrag();
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

	async function openConfiguration() {
		if (!layout?.valid || saving || configOpen) return;
		configVersion += 1;
		draft = [...layout.sections];
		selectedBuiltin = '';
		actionError = '';
		configOpen = true;
		void refreshDraftShelfStates();
		await tick();
		if (!mounted || !configOpen || !configDialog) return;
		configDialog.showModal();
		configHeading?.focus();
	}

	function closeConfiguration() {
		if (saving) return;
		endDrag();
		configDialog?.close();
		configOpen = false;
		configVersion += 1;
		metadataVersion += 1;
		if (dashboardConfigure.trigger?.isConnected) dashboardConfigure.trigger.focus();
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

	function startDrag(event: PointerEvent, id: SectionId) {
		if (saving || dragging || !event.isPrimary || event.button !== 0) return;
		if (event.target instanceof Element && event.target.closest('button')) return;
		event.preventDefault();
		(event.currentTarget as HTMLElement).focus({ preventScroll: true });
		dragging = id;
		window.addEventListener('pointermove', dragMove);
		window.addEventListener('pointerup', endDrag);
		window.addEventListener('pointercancel', endDrag);
	}

	// Offsets ignore the flip transforms, so rows that are still animating do not
	// make the dragged row jump back and forth.
	function dragMove(event: PointerEvent) {
		if (!dragging || !sectionList) return;
		const y = event.clientY - sectionList.getBoundingClientRect().top;
		const rows = [...sectionList.querySelectorAll<HTMLElement>('[data-config-section]')]
			.filter((row) => row.dataset.configSection !== dragging);
		const target = rows.filter((row) => y > row.offsetTop + row.offsetHeight / 2).length;
		if (draft.indexOf(dragging) !== target) draft = moveSectionTo(draft, dragging, target);
	}

	function endDrag() {
		dragging = null;
		window.removeEventListener('pointermove', dragMove);
		window.removeEventListener('pointerup', endDrag);
		window.removeEventListener('pointercancel', endDrag);
	}

	async function moveWithKeyboard(event: KeyboardEvent, id: SectionId) {
		if (saving || !event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
		event.preventDefault();
		draft = moveSection(draft, id, event.key === 'ArrowUp' ? -1 : 1);
		await tick();
		sectionList?.querySelector<HTMLElement>(`[data-config-section="${id}"]`)?.focus();
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
			<div class="space-y-2 card p-6">
				<h2 class="text-lg font-semibold">{m['ux5.empty_dashboard']()}</h2>
				<p class="text-slate-600">{m['ux5.empty_dashboard_help']()}</p>
			</div>
		{:else}
			<div class="space-y-5">
				{#each layout.sections as id (id)}
					<DashboardRow {id} removing={saving} onShelfState={setShelfState} onRemove={removeUnavailable} />
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
				<div>
					<h3 id="dashboard-config-sections" class="font-semibold">{m['ux5.sections']()}</h3>
					<p id="dashboard-config-hint" class="mt-1 text-xs text-slate-500">{m['ux5.drag_hint']()}</p>
				</div>
				<ol bind:this={sectionList} class="relative space-y-2 {dragging ? 'select-none' : ''}">
					{#each draft as id (id)}
						{@const label = sectionLabel(id, shelfStates[id])}
						{@const held = dragging === id}
						<!-- Sortable rows are focusable so they can be reordered with Alt+Up/Down. -->
						<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
						<li
							animate:flip={{ duration: 150 }}
							class="relative flex touch-none items-center gap-3 rounded-lg border p-3 transition duration-150 focus-visible:outline-2 focus-visible:outline-emerald-700 {held ? 'z-10 scale-[1.02] cursor-grabbing border-emerald-500 bg-emerald-50 shadow-lg ring-2 ring-emerald-500/30' : 'cursor-grab border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'}"
							tabindex="0"
							aria-describedby="dashboard-config-hint"
							aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
							data-config-section={id}
							data-dragging={held ? 'true' : undefined}
							onpointerdown={(event) => startDrag(event, id)}
							onkeydown={(event) => void moveWithKeyboard(event, id)}
						>
							<svg aria-hidden="true" class="size-4 shrink-0 {held ? 'text-emerald-600' : 'text-slate-400'}" viewBox="0 0 16 16" fill="currentColor">
								<circle cx="5.5" cy="3.5" r="1.25" /><circle cx="10.5" cy="3.5" r="1.25" />
								<circle cx="5.5" cy="8" r="1.25" /><circle cx="10.5" cy="8" r="1.25" />
								<circle cx="5.5" cy="12.5" r="1.25" /><circle cx="10.5" cy="12.5" r="1.25" />
							</svg>
							<span class="min-w-0 flex-1 break-words font-medium">{label}</span>
							<button type="button" class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-red-50 hover:text-red-700 focus-visible:outline-2 disabled:opacity-40" aria-label={m['ux5.remove']({ section: label })} title={m['ux5.remove']({ section: label })} disabled={saving} onclick={() => (draft = draft.filter((section) => section !== id))}><Icon name="x" class="size-4" /></button>
						</li>
					{/each}
					<li class="flex items-center gap-3 rounded-lg border border-dashed border-slate-300 p-3" data-config-add>
						<span class="size-4 shrink-0" aria-hidden="true"></span>
						<select aria-label={m['ux5.select_builtin']()} bind:value={selectedBuiltin} disabled={saving || !availableBuiltins.length} class="{filterControlClass} min-w-0 flex-1">
							<option value="">{m['ux5.select_placeholder']()}</option>
							{#each availableBuiltins as id}<option value={id}>{sectionLabel(id)}</option>{/each}
						</select>
						<button type="button" class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-emerald-700 hover:bg-emerald-50 focus-visible:outline-2 disabled:opacity-40" aria-label={m['ux5.add_builtin']()} title={m['ux5.add_builtin']()} disabled={saving || !selectedBuiltin} onclick={addBuiltIn}><Icon name="plus" class="size-5" /></button>
					</li>
				</ol>
				{#if !draft.length}
					<p class="text-sm text-slate-600">{m['ux5.empty_draft']()}</p>
				{/if}
			</section>

			<div class="flex flex-wrap justify-end gap-3 border-t border-slate-200 pt-4">
				<button class="rounded-md border border-slate-300 px-4 py-2 font-medium focus-visible:outline-2 disabled:opacity-50" disabled={saving} onclick={closeConfiguration}>{m['ux5.cancel']()}</button>
				<button class="rounded-md bg-emerald-700 px-4 py-2 font-medium text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:opacity-50" disabled={saving} onclick={() => void persist(draft, true)}>{saving ? m['ux5.saving']() : m['ux5.save']()}</button>
			</div>
		</div>
	</dialog>
{/if}

<style>
	dialog::backdrop {
		background: rgb(15 23 42 / 0.6);
	}
</style>
