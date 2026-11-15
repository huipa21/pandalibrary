<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import LibraryForm from '#lib/admin/LibraryForm.svelte';
	import { updateLibrary } from '#lib/admin/api.js';
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

<svelte:head>
	<title>{library?.name ?? m['ux1.library.settings']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-6">
	<a href="/libraries" class="rounded-sm underline underline-offset-4 focus-visible:outline-2">{m['ux1.library.manage']()}</a>
	{#if loading}
		<p role="status" class="text-slate-600">{m['catalog.loading']()}</p>
	{:else if error}
		<AdminAlert message={error} onretry={() => load(page.params.id ?? '')} />
	{:else if library}
		<header>
			<h1 class="text-3xl font-semibold tracking-tight break-words">{library.name}</h1>
			<p class="mt-2 text-slate-600">{m['ux1.library.settings']()}</p>
		</header>
		{#if notice}<p class="text-sm text-green-700" role="status">{notice}</p>{/if}
		<section class="card space-y-4 p-5" aria-label={m['ux1.library.settings']()}>
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
		</section>
		{#if isAdmin}
			{#key library.id}<LibraryAccess {library} />{/key}
		{/if}
	{/if}
</section>
