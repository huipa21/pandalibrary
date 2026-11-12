<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import UserSelector from '#lib/admin/users/UserSelector.svelte';
	import LibraryForm from '#lib/admin/LibraryForm.svelte';
	import PagerFooter from '#lib/admin/PagerFooter.svelte';
	import {
		createLibrary,
		deleteLibrary,
		grantLibraryAccess,
		listAdminLibraries,
		listLibraryAccess,
		revokeLibraryAccess,
		updateLibrary
	} from '#lib/admin/api.js';
	import { adminErrorKey, libraryFieldErrorKey, libraryPatch } from '#lib/admin/form.js';
	import { formatTimestamp } from '#lib/admin/jobs.js';
	import type { AccessEntry, Library } from '#lib/admin/types.js';
	import { panelClass, smallDangerButton, smallSecondaryButton, warningBox } from '#lib/admin/ui.js';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { translate } from '#lib/paging/translate.js';
	import { getLibrary } from '#lib/catalog/api.js';

	const libraries = new CursorPager<Library>();
	const access = new CursorPager<AccessEntry>();
	let notice = $state('');
	let editing = $state<number | null>(null);
	let deleting = $state<number | null>(null);
	let rowErrors = $state<Record<number, string>>({});
	let selected = $state<Library | null>(null);
	let accessNotice = $state('');
	let accessError = $state('');
	let revoking = $state<number | null>(null);
	let accessHeading = $state<HTMLHeadingElement | null>(null);
	let linkedLibrary = $state<Library | null>(null);
	let linkedLoading = $state(false);
	let linkedError = $state('');
	let linkRequest = 0;

	$effect(() => {
		page.url.search;
		untrack(() => void openDeepLink());
	});

	async function openDeepLink() {
		const request = ++linkRequest;
		const id = page.url.searchParams.get('edit');
		const creating = page.url.searchParams.get('create') === '1';
		linkedLibrary = null;
		linkedError = '';
		linkedLoading = false;
		editing = null;
		if (id !== null) {
			const libraryID = Number(id);
			if (!/^\d+$/.test(id) || !Number.isSafeInteger(libraryID) || libraryID < 1) {
				linkedError = m['catalog.error.not_found']();
				return;
			}
			linkedLoading = true;
			try {
				const library = await getLibrary(libraryID);
				if (request !== linkRequest) return;
				linkedLibrary = library;
				await tick();
				if (request === linkRequest) document.getElementById(`linked-library-${library.id}-name`)?.focus();
			} catch (cause) {
				if (request === linkRequest) linkedError = translate(adminErrorKey(cause, 'load'));
			} finally {
				if (request === linkRequest) linkedLoading = false;
			}
		} else if (creating) {
			await tick();
			if (request === linkRequest) document.getElementById('create-library-name')?.focus();
		}
	}

	function closeLinkedEditor() {
		linkedLibrary = null;
		void goto('/admin/libraries', { replace: true, reset: false });
	}

	function librariesChanged() {
		window.dispatchEvent(new CustomEvent('pandalibrary-libraries-changed'));
	}

	onMount(() => {
		void libraries.reset((cursor, signal) => listAdminLibraries({ cursor, signal }));
	});

	onDestroy(() => {
		linkRequest++;
		libraries.dispose();
		access.dispose();
	});

	function setRowError(id: number, message: string) {
		rowErrors = { ...rowErrors, [id]: message };
	}

	function clearRowError(id: number) {
		const next = { ...rowErrors };
		delete next[id];
		rowErrors = next;
	}

	async function create(name: string, slug: string): Promise<string | null> {
		notice = '';
		try {
			const library = await createLibrary(name, slug);
			notice = m['admin.libraries.created']({ name: library.name });
			void libraries.reload();
			librariesChanged();
			return null;
		} catch (cause) {
			return translate(adminErrorKey(cause, 'save_library'));
		}
	}

	async function save(library: Library, name: string, slug: string): Promise<string | null> {
		notice = '';
		const result = libraryPatch(library, { name, slug });
		if (!result.ok) return translate(libraryFieldErrorKey(result.error));
		try {
			const updated = await updateLibrary(library.id, result.patch);
			editing = null;
			if (linkedLibrary?.id === library.id) closeLinkedEditor();
			notice = m['admin.libraries.saved']({ name: updated.name });
			if (selected?.id === updated.id) selected = updated;
			void libraries.reload();
			librariesChanged();
			return null;
		} catch (cause) {
			return translate(adminErrorKey(cause, 'save_library'));
		}
	}

	async function remove(library: Library) {
		if (deleting !== null) return;
		if (!window.confirm(m['admin.libraries.delete_confirm']({ name: library.name }))) return;
		notice = '';
		clearRowError(library.id);
		deleting = library.id;
		try {
			await deleteLibrary(library.id);
			notice = m['admin.libraries.deleted']({ name: library.name });
			if (selected?.id === library.id) selectLibrary(null);
			void libraries.reload();
			librariesChanged();
		} catch (cause) {
			setRowError(library.id, translate(adminErrorKey(cause, 'delete_library')));
		} finally {
			deleting = null;
		}
	}

	function selectLibrary(library: Library | null) {
		selected = library;
		accessNotice = '';
		accessError = '';
		void access.reset(library ? (cursor, signal) => listLibraryAccess(library.id, { cursor, signal }) : null);
		if (library) void tick().then(() => accessHeading?.focus());
	}

	async function grant(userID: number): Promise<string | null> {
		const library = selected;
		if (!library) return null;
		accessNotice = '';
		accessError = '';
		try {
			await grantLibraryAccess(library.id, userID);
			if (selected?.id !== library.id) return null;
			accessNotice = m['admin.access.granted']({ user: userID, library: library.name });
			void access.reload();
			return null;
		} catch (cause) {
			if (selected?.id !== library.id) return null;
			return translate(adminErrorKey(cause, 'grant'));
		}
	}

	async function revoke(entry: AccessEntry) {
		const library = selected;
		if (!library || revoking !== null) return;
		if (!window.confirm(m['admin.access.revoke_confirm']({ user: entry.user_id, library: library.name }))) return;
		accessNotice = '';
		accessError = '';
		revoking = entry.user_id;
		try {
			await revokeLibraryAccess(library.id, entry.user_id);
			if (selected?.id !== library.id) return;
			accessNotice = m['admin.access.revoked']({ user: entry.user_id, library: library.name });
			void access.reload();
		} catch (cause) {
			if (selected?.id === library.id) accessError = translate(adminErrorKey(cause, 'revoke'));
		} finally {
			revoking = null;
		}
	}
</script>

<svelte:head>
	<title>{m['admin.libraries.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-8" aria-labelledby="libraries-heading">
	<header class="space-y-2">
		<h1 id="libraries-heading" class="text-3xl font-semibold tracking-tight">{m['admin.libraries.title']()}</h1>
		<p class="text-slate-600">{m['admin.libraries.description']()}</p>
	</header>

	<section class={panelClass} aria-labelledby="create-library-heading">
		<h2 id="create-library-heading" class="text-xl font-semibold">{m['admin.libraries.create_heading']()}</h2>
		<LibraryForm
			idPrefix="create-library"
			submitLabel={m['admin.libraries.create']()}
			busyLabel={m['admin.libraries.creating']()}
			suggestSlugFromName
			resetOnSuccess
			onsave={create}
		/>
	</section>

	{#if notice}<p class="text-sm text-green-700" role="status">{notice}</p>{/if}

	{#if linkedLoading}
		<p class="text-slate-600" role="status">{m['admin.libraries.loading']()}</p>
	{/if}
	{#if linkedError}
		<AdminAlert message={linkedError} onretry={openDeepLink} />
	{/if}
	{#if linkedLibrary}
		{@const library = linkedLibrary}
		<section class={panelClass} aria-labelledby="linked-library-heading">
			<h2 id="linked-library-heading" class="text-xl font-semibold">{m['admin.libraries.edit_heading']({ name: library.name })}</h2>
			{#key library.id}
				<LibraryForm
					idPrefix={`linked-library-${library.id}`}
					submitLabel={m['admin.libraries.save']()}
					busyLabel={m['admin.libraries.saving']()}
					initialName={library.name}
					initialSlug={library.slug}
					onsave={(name, slug) => save(library, name, slug)}
					oncancel={closeLinkedEditor}
				/>
			{/key}
		</section>
	{/if}

	<section class="space-y-4" aria-labelledby="library-list-heading" aria-busy={libraries.status === 'loading'}>
		<h2 id="library-list-heading" class="text-xl font-semibold">{m['admin.libraries.list_heading']()}</h2>
		<p class="text-sm text-slate-600">{m['admin.libraries.delete_rule']()}</p>
		{#if libraries.status === 'error'}
			<AdminAlert message={translate(adminErrorKey(libraries.error, 'load'))} error={libraries.error} onretry={() => libraries.retry()} />
		{:else if libraries.status !== 'ready'}
			<p class="text-slate-600" role="status">{m['admin.libraries.loading']()}</p>
		{:else if libraries.empty}
			<p class="card p-6 text-slate-600">{m['admin.libraries.empty']()}</p>
		{:else}
			<ul class="space-y-3">
				{#each libraries.items as library (library.id)}
					<li class="space-y-3 card p-4" aria-label={library.name}>
						{#if editing === library.id}
							<h3 class="font-semibold">{m['admin.libraries.edit_heading']({ name: library.name })}</h3>
							<LibraryForm
								idPrefix={`edit-library-${library.id}`}
								submitLabel={m['admin.libraries.save']()}
								busyLabel={m['admin.libraries.saving']()}
								initialName={library.name}
								initialSlug={library.slug}
								onsave={(name, slug) => save(library, name, slug)}
								oncancel={() => (editing = null)}
							/>
						{:else}
							<div class="flex flex-wrap items-start justify-between gap-3">
								<div class="min-w-0 space-y-1">
									<h3 class="font-semibold break-words">{library.name}</h3>
									<p class="text-sm text-slate-600">
										<span class="font-mono">{library.slug}</span>
										<span aria-hidden="true"> · </span>
										{m['admin.libraries.id']({ id: library.id })}
									</p>
								</div>
								<div class="flex flex-wrap gap-2">
									<button
										type="button"
										class={smallSecondaryButton}
										onclick={() => {
											clearRowError(library.id);
											linkedLibrary = null;
											editing = library.id;
										}}
									>{m['admin.libraries.edit']()}<span class="sr-only"> {library.name}</span></button>
									<button
										type="button"
										class={smallSecondaryButton}
										aria-pressed={selected?.id === library.id}
										onclick={() => selectLibrary(library)}
									>{m['admin.libraries.manage_access']()}<span class="sr-only"> {library.name}</span></button>
									<button type="button" class={smallDangerButton} disabled={deleting !== null} onclick={() => remove(library)}>
										{deleting === library.id ? m['admin.libraries.deleting']() : m['admin.libraries.delete']()}<span class="sr-only"> {library.name}</span>
									</button>
								</div>
							</div>
						{/if}
						{#if rowErrors[library.id]}
							<AdminAlert message={rowErrors[library.id]} />
						{/if}
					</li>
				{/each}
			</ul>
			<PagerFooter pager={libraries} loadMoreLabel={m['admin.libraries.load_more']()} />
		{/if}
	</section>

	{#if selected}
		<section class={panelClass} aria-labelledby="access-heading" aria-busy={access.status === 'loading'}>
			<div class="flex flex-wrap items-start justify-between gap-3">
				<h2 id="access-heading" class="text-xl font-semibold" tabindex="-1" bind:this={accessHeading}>
					{m['admin.access.heading']({ name: selected.name })}
				</h2>
				<button type="button" class={smallSecondaryButton} onclick={() => selectLibrary(null)}>{m['admin.access.close']()}</button>
			</div>
			<p class={warningBox}>{m['admin.access.admin_note']()}</p>
			<UserSelector
				idPrefix="grant-user"
				label={m['admin.access.user_id']()}
				submitLabel={m['admin.access.grant']()}
				busyLabel={m['admin.access.granting']()}
				resetOnSuccess
				onsubmit={(user) => grant(user.id)}
			/>
			{#if accessNotice}<p class="text-sm text-green-700" role="status">{accessNotice}</p>{/if}
			{#if accessError}<AdminAlert message={accessError} />{/if}

			<h3 class="font-semibold">{m['admin.access.list_heading']()}</h3>
			{#if access.status === 'error'}
				<AdminAlert message={translate(adminErrorKey(access.error, 'load_access'))} error={access.error} onretry={() => access.retry()} />
			{:else if access.status !== 'ready'}
				<p class="text-slate-600" role="status">{m['admin.access.loading']()}</p>
			{:else if access.empty}
				<p class="text-slate-600">{m['admin.access.empty']()}</p>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full text-left text-sm">
						<thead class="border-b border-slate-200 text-slate-600">
							<tr>
								<th scope="col" class="py-2 pr-4 font-medium">{m['admin.access.user_column']()}</th>
								<th scope="col" class="py-2 pr-4 font-medium">{m['admin.access.granted_column']()}</th>
								<th scope="col" class="py-2 font-medium"><span class="sr-only">{m['admin.actions']()}</span></th>
							</tr>
						</thead>
						<tbody>
							{#each access.items as entry (entry.user_id)}
								<tr class="border-b border-slate-100">
									<td class="py-2 pr-4 font-mono">{entry.user_id}</td>
									<td class="py-2 pr-4">{formatTimestamp(entry.granted_at)}</td>
									<td class="py-2 text-right">
										<button type="button" class={smallDangerButton} disabled={revoking !== null} onclick={() => revoke(entry)}>
											{revoking === entry.user_id ? m['admin.access.revoking']() : m['admin.access.revoke']()}<span class="sr-only"> {m['admin.access.user_label']({ user: entry.user_id })}</span>
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<PagerFooter pager={access} loadMoreLabel={m['admin.access.load_more']()} />
			{/if}
		</section>
	{/if}
</section>
