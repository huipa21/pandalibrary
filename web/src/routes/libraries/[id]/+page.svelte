<script lang="ts">
	import { showLoadingAfterDelay } from '#lib/ui/deferred.js';
	import { onDestroy, untrack } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import * as m from '#lib/paraglide/messages.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import LibraryForm from '#lib/admin/LibraryForm.svelte';
	import { updateLibrary } from '#lib/admin/api.js';
	import { dangerButton } from '#lib/admin/ui.js';
	import LibraryDeleteDialog from '#lib/libraries/LibraryDeleteDialog.svelte';
	import Icon from '#lib/bookview/Icon.svelte';
	import { adminErrorKey, libraryFieldErrorKey, libraryPatch } from '#lib/admin/form.js';
	import type { Library } from '#lib/catalog/types.js';
	import { getLibrary } from '#lib/catalog/api.js';
	import LibraryAccess from '#lib/libraries/LibraryAccess.svelte';
	import IconPicker from '#lib/shelves/IconPicker.svelte';
	import { getSessionViewer } from '#lib/shelves/api.js';
	import { isAdministrator } from '#lib/shelves/form.js';
	import { translate } from '#lib/paging/translate.js';

	let library = $state<Library | null>(null);
	let isAdmin = $state(false);
	let loading = $state(true);
	let error = $state('');
	let notice = $state('');
	let deleteTarget = $state<Library | null>(null);
	let request = 0;

	$effect(() => {
		const id = page.params.id ?? '';
		untrack(() => void load(id));
	});
	onDestroy(() => { request++; });

	async function load(rawID: string) {
		const current = ++request;
		loading = true;
		error = '';
		notice = '';
		deleteTarget = null;
		library = null;
		isAdmin = false;
		const id = Number(rawID);
		if (!/^\d+$/.test(rawID) || !Number.isSafeInteger(id) || id < 1) {
			error = m['catalog.error.not_found']();
			loading = false;
			return;
		}
		try {
			const [result, viewer] = await Promise.all([getLibrary(id), getSessionViewer()]);
			if (current !== request) return;
			library = result;
			isAdmin = isAdministrator(viewer);
		} catch (cause) {
			if (current === request) error = translate(adminErrorKey(cause, 'load'));
		} finally {
			if (current === request) loading = false;
		}
	}

	async function save(name: string, slug: string, icon: string): Promise<string | null> {
		if (!library || !isAdmin) return m['catalog.error.not_found']();
		const current = library;
		const result = libraryPatch(current, { name, slug, icon });
		if (!result.ok) return translate(libraryFieldErrorKey(result.error));
		notice = '';
		try {
			const updated = await updateLibrary(current.id, result.patch);
			if (library?.id !== current.id) return null;
			library = updated;
			notice = m['admin.libraries.saved']({ name: updated.name });
			window.dispatchEvent(new CustomEvent('pandalibrary-libraries-changed'));
			return null;
		} catch (cause) {
			return translate(adminErrorKey(cause, 'save_library'));
		}
	}

</script>

<LibraryDeleteDialog library={deleteTarget} onclose={() => deleteTarget = null}
	ondeleted={async (deleted) => { if (library?.id === deleted.id) await goto('/libraries'); }} />
<svelte:head>
	<title>{library?.name ?? m['ux1.library.settings']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="card space-y-4 p-6" aria-label={m['ux1.library.settings']()}>
	<header class="flex items-center justify-between gap-4">
		<h1 class="text-xl font-semibold">{m['ux1.library.settings']()}</h1>
		<a href="/libraries" class="shell-icon-button" aria-label={m['bd1.back']()} title={m['bd1.back']()}><Icon name="arrow-left" /></a>
	</header>
	{#if loading}
		<p use:showLoadingAfterDelay role="status" class="text-slate-600">{m['catalog.loading']()}</p>
	{:else if error}
		<AdminAlert message={error} onretry={() => load(page.params.id ?? '')} />
	{:else if library}
		{#if notice}<p class="text-sm text-green-700" role="status">{notice}</p>{/if}
		{#key library.id}
			{#if isAdmin}
				<LibraryForm idPrefix={`library-settings-${library.id}`} initialName={library.name} initialSlug={library.slug} initialIcon={library.icon ?? ''}
					submitLabel={m['admin.libraries.save']()} busyLabel={m['admin.libraries.saving']()} onsave={save} />
			{:else}
				<dl class="grid gap-4 sm:grid-cols-2">
					<div><dt class="text-sm font-medium">{m['admin.libraries.form.name']()}</dt><dd class="mt-1 break-words">{library.name}</dd></div>
					<div><dt class="text-sm font-medium">{m['admin.libraries.form.slug']()}</dt><dd class="mt-1 break-words font-mono">{library.slug}</dd></div>
				</dl>
				<IconPicker idPrefix={`library-settings-${library.id}`} value={library.icon ?? ''} disabled />
			{/if}
		{/key}
		{#if isAdmin}
			{#key library.id}<LibraryAccess {library} />{/key}
			<p class="text-sm text-slate-600">{m['admin.libraries.delete_rule']()}</p>
			<button type="button" class={dangerButton} aria-label={m['catalog.library.delete']({ name: library.name })}
				onclick={() => deleteTarget = library}>{m['admin.libraries.delete']()}</button>
		{/if}
	{/if}
</section>
