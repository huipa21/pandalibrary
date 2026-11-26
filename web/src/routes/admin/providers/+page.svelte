<script lang="ts">
	import { showLoadingAfterDelay } from '#lib/ui/deferred.js';
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import ProviderDialog from '#lib/admin/ProviderDialog.svelte';
	import { createProvider, deleteProvider, listProviders, updateProvider } from '#lib/admin/api.js';
	import { adminErrorKey, providerCapabilities } from '#lib/admin/form.js';
	import { formatTimestamp } from '#lib/admin/jobs.js';
	import { providerName } from '#lib/admin/provider-name.js';
	import type { ProviderCatalogEntry, ProviderCreate, ProviderPatch, ProviderSettings } from '#lib/admin/types.js';
	import { focusRing, panelClass } from '#lib/admin/ui.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import { controlIconClass, primaryIconControlClass } from '#lib/catalog/filter-styles.js';
	import { translate } from '#lib/paging/translate.js';

	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let loadError = $state<unknown>(null);
	let providers = $state<ProviderSettings[]>([]);
	let catalog = $state<ProviderCatalogEntry[]>([]);
	let creating = $state(false);
	let editing = $state<ProviderSettings | null>(null);
	let notice = $state('');
	let controller: AbortController | null = null;

	const busy = $derived(creating || editing !== null);
	// Builtin providers that are not configured yet, ordered by their default priority.
	const available = $derived(
		catalog
			.filter((entry) => !providers.some((item) => item.provider === entry.provider))
			.sort((a, b) => a.default_priority - b.default_priority || a.provider.localeCompare(b.provider))
	);

	onMount(() => void load());
	onDestroy(() => controller?.abort());

	function byPriority(items: ProviderSettings[]): ProviderSettings[] {
		return [...items].sort((a, b) => a.priority - b.priority || a.provider.localeCompare(b.provider));
	}

	async function load() {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		status = 'loading';
		loadError = null;
		try {
			const result = await listProviders(current.signal);
			if (current.signal.aborted) return;
			providers = byPriority(result.providers);
			catalog = result.catalog;
			status = 'ready';
		} catch (cause) {
			if (current.signal.aborted) return;
			loadError = cause;
			status = 'error';
		}
	}

	function tokenLabel(settings: ProviderSettings): string {
		const capabilities = providerCapabilities(settings.provider);
		if (capabilities.token === 'none') return m['admin.providers.token_not_used']();
		return settings.has_token ? m['admin.providers.token_stored']() : m['admin.providers.token_missing']();
	}

	async function create(input: ProviderCreate): Promise<string | null> {
		notice = '';
		try {
			const settings = await createProvider(input);
			providers = byPriority([...providers, settings]);
			notice = m['admin.providers.created']({ name: providerName(settings.provider) });
			return null;
		} catch (cause) {
			return translate(adminErrorKey(cause, 'create_provider'));
		}
	}

	async function update(patch: ProviderPatch): Promise<string | null> {
		const target = editing;
		if (!target) return null;
		notice = '';
		try {
			const settings = await updateProvider(target.provider, patch);
			providers = byPriority(providers.map((item) => (item.provider === settings.provider ? settings : item)));
			notice = m['admin.providers.saved']({ name: providerName(settings.provider) });
			return null;
		} catch (cause) {
			return translate(adminErrorKey(cause, 'save_provider'));
		}
	}

	async function remove(): Promise<string | null> {
		const target = editing;
		if (!target) return null;
		notice = '';
		try {
			await deleteProvider(target.provider);
			providers = providers.filter((item) => item.provider !== target.provider);
			notice = m['admin.providers.deleted']({ name: providerName(target.provider) });
			return null;
		} catch (cause) {
			return translate(adminErrorKey(cause, 'delete_provider'));
		}
	}
</script>

<svelte:head>
	<title>{m['admin.providers.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-8" aria-labelledby="providers-heading">
	<h1 id="providers-heading" class="sr-only">{m['admin.providers.title']()}</h1>

	{#if creating}
		<ProviderDialog open mode="create" catalog={available} onclose={() => (creating = false)} oncreate={create} />
	{:else if editing}
		<ProviderDialog open mode="edit" settings={editing} onclose={() => (editing = null)} onupdate={update} ondelete={remove} />
	{/if}

	{#if notice}<p class="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800" role="status">{notice}</p>{/if}

	<section class={panelClass} aria-busy={status === 'loading'}>
		<div class="flex flex-wrap items-start gap-3">
			<div class="min-w-0 flex-1 space-y-1">
				<p class="text-sm text-slate-600">{m['admin.providers.description']()}</p>
				<p class="text-xs text-slate-500">{m['admin.providers.list_hint']()}</p>
			</div>
			<button
				type="button"
				class={`ml-auto ${primaryIconControlClass}`}
				aria-label={m['admin.providers.add']()}
				title={available.length === 0 ? m['admin.providers.none_available']() : m['admin.providers.add']()}
				disabled={busy || status !== 'ready' || available.length === 0}
				onclick={() => (creating = true)}
			>
				<Icon name="plus" class={controlIconClass} />
			</button>
		</div>

		{#if status === 'error'}
			<AdminAlert message={translate(adminErrorKey(loadError, 'load'))} error={loadError} onretry={() => void load()} />
		{:else if status === 'loading'}
			<p use:showLoadingAfterDelay class="text-slate-600" role="status">{m['admin.providers.loading']()}</p>
		{:else if providers.length === 0}
			<p class="text-slate-600">{m['admin.providers.empty']()}</p>
		{:else}
			<ul class="divide-y divide-slate-200 rounded-md border border-slate-200">
				{#each providers as settings (settings.provider)}
					<li>
						<button
							type="button"
							class={`flex w-full flex-wrap items-center gap-x-6 gap-y-2 p-4 text-left hover:bg-slate-50 disabled:opacity-60 disabled:hover:bg-transparent ${focusRing}`}
							disabled={busy}
							onclick={() => (editing = settings)}
						>
							<span class="min-w-0 flex-1">
								<span class="block font-medium">{providerName(settings.provider)}</span>
								<span class="block text-sm text-slate-600">
									{settings.enabled ? m['admin.providers.state_enabled']() : m['admin.providers.state_disabled']()}
									· {tokenLabel(settings)}
									· {m['admin.providers.updated']({ time: formatTimestamp(settings.updated_at) })}
								</span>
							</span>
							<span class="text-sm text-slate-600">{m['admin.providers.priority']()} {settings.priority}</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</section>
