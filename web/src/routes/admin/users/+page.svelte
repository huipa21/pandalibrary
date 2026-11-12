<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import PagerFooter from '#lib/admin/PagerFooter.svelte';
	import UserForm from '#lib/admin/UserForm.svelte';
	import { createUser, deleteUser, listAdminUsers, resetUserPassword, revokeUserCredentials, updateUser, type UserSearchCategory } from '#lib/admin/api.js';
	import { adminErrorKey, userPatch, type UserFormDraft } from '#lib/admin/form.js';
	import { formatTimestamp } from '#lib/admin/jobs.js';
	import type { User } from '#lib/admin/types.js';
	import { inputClass, panelClass, primaryButton, smallDangerButton, smallSecondaryButton } from '#lib/admin/ui.js';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { translate } from '#lib/paging/translate.js';
	import { currentAccount, deactivateOffline } from '#lib/sync/client.js';
	import { withSessionLock } from '#lib/sync/engine.js';

	const users = new CursorPager<User>();
	let creating = $state(false);
	let editingUser = $state<User | null>(null);
	let resettingUser = $state<User | null>(null);
	let actionInProgress = $state(false);
	let notice = $state('');
	let actionError = $state('');
	let query = $state('');
	let category = $state<UserSearchCategory>('all');
	let selectedIDs = $state<number[]>([]);
	const selected = $derived(users.items.filter((user) => selectedIDs.includes(user.id)));
	const single = $derived(selected.length === 1 ? selected[0] : null);
	const allSelected = $derived(users.items.length > 0 && selected.length === users.items.length);
	const formOpen = $derived(creating || editingUser !== null || resettingUser !== null);
	const busy = $derived(formOpen || actionInProgress);

	onMount(() => { void users.reset((cursor, signal) => listAdminUsers({ cursor, signal })); });
	onDestroy(() => users.dispose());

	function search(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		const q = query.trim();
		const field = category;
		selectedIDs = [];
		void users.reset((cursor, signal) => listAdminUsers({ cursor, signal, q, category: field }));
	}

	function select(id: number, checked: boolean) {
		selectedIDs = checked ? [...selectedIDs, id] : selectedIDs.filter((value) => value !== id);
	}

	async function create(input: UserFormDraft): Promise<string | null> {
		notice = '';
		actionError = '';
		try {
			await createUser(input.username, input.displayName, input.password, input.role, input.locale);
			creating = false;
			notice = m['admin.users.form.success_create']();
			await users.reload();
			return null;
		} catch (cause) {
			return translate(adminErrorKey(cause, 'create'));
		}
	}

	async function save(input: UserFormDraft): Promise<string | null> {
		const user = editingUser;
		if (!user) return m['ux8.change_failed']();
		const patch = userPatch(user, input);
		if (!patch.ok) return translate(`admin.users.form.error.${patch.error}`);
		notice = '';
		actionError = '';
		try {
			const self = user.id === currentAccount();
			await updateUser(user.id, patch.patch);
			if (self) {
				window.location.reload();
				return null;
			}
			editingUser = null;
			notice = m['admin.users.form.success_update']();
			await users.reload();
			return null;
		} catch (cause) {
			return translate(adminErrorKey(cause, 'update'));
		}
	}

	async function resetPassword(input: UserFormDraft): Promise<string | null> {
		const user = resettingUser;
		if (!user) return m['ux8.change_failed']();
		notice = '';
		actionError = '';
		try {
			const self = user.id === currentAccount();
			await withSessionLock(async () => {
				await resetUserPassword(user.id, input.password);
				if (self) await deactivateOffline();
			});
			if (self) {
				window.location.assign('/login');
				return null;
			}
			resettingUser = null;
			notice = m['admin.users.form.success_password_reset']();
			return null;
		} catch (cause) {
			return translate(adminErrorKey(cause, 'reset'));
		}
	}

	async function bulk(action: 'enable' | 'disable' | 'revoke' | 'delete') {
		if (busy || selected.length === 0) return;
		const targets = selected
			.filter((user) => action === 'enable' ? user.disabled : action === 'disable' ? !user.disabled : true)
			.sort((a, b) => Number(a.id === currentAccount()) - Number(b.id === currentAccount()));
		if (targets.length === 0) return;
		const labels = {
			enable: m['admin.users.enable'](), disable: m['admin.users.disable'](),
			revoke: m['ux8.revoke'](), delete: m['admin.users.delete']()
		};
		const warning = action === 'delete' ? m['admin.users.bulk_delete_warning']()
			: action === 'disable' || action === 'revoke' ? m['admin.users.bulk_credentials_warning']() : '';
		if (!window.confirm(m['admin.users.bulk_confirm']({
			action: labels[action], users: targets.map((user) => user.username).join(', '), warning
		}))) return;
		actionInProgress = true;
		notice = '';
		actionError = '';
		let completed = 0;
		try {
			for (const user of targets) {
				const self = user.id === currentAccount();
				if (action === 'revoke') {
					await withSessionLock(async () => {
						await revokeUserCredentials(user.id);
						if (self) await deactivateOffline();
					});
				} else if (action === 'delete') {
					await deleteUser(user.id);
				} else {
					await updateUser(user.id, { disabled: action === 'disable' });
				}
				completed += 1;
				selectedIDs = selectedIDs.filter((id) => id !== user.id);
				if (self && action === 'revoke') {
					window.location.assign('/login');
					return;
				}
			}
		} catch (cause) {
			actionError = translate(adminErrorKey(cause, action === 'delete' ? 'delete' : 'update'));
		} finally {
			notice = m['admin.users.bulk_completed']({ count: completed });
			await users.reload();
			actionInProgress = false;
		}
	}
</script>

<svelte:head>
	<title>{m['admin.users.heading']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-8" aria-labelledby="users-heading">
	<header class="flex flex-wrap items-start justify-between gap-3">
		<div class="space-y-2">
			<h1 id="users-heading" class="text-3xl font-semibold tracking-tight">{m['admin.users.heading']()}</h1>
			<p class="text-slate-600">{m['admin.overview.users']()}</p>
		</div>
		<button type="button" class={primaryButton} disabled={formOpen || actionInProgress} onclick={() => (creating = true)}>
			{m['admin.users.create_label']()}
		</button>
	</header>
	{#if notice}<p class="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800" role="status">{notice}</p>{/if}
	{#if actionError}<AdminAlert message={actionError} />{/if}

	{#if creating}
		<section class={panelClass} aria-labelledby="create-heading">
			<h2 id="create-heading" class="text-xl font-semibold">{m['admin.users.form.create_title']()}</h2>
			<UserForm mode="create" onsubmit={create} oncancel={() => (creating = false)} />
		</section>
	{:else if editingUser}
		<section class={panelClass} aria-labelledby="edit-heading">
			<h2 id="edit-heading" class="text-xl font-semibold">{m['admin.users.form.edit_title']()}</h2>
			{#key editingUser.id}<UserForm mode="edit" user={editingUser} onsubmit={save} oncancel={() => (editingUser = null)} />{/key}
		</section>
	{:else if resettingUser}
		<section class={panelClass} aria-labelledby="reset-heading">
			<h2 id="reset-heading" class="text-xl font-semibold">{m['admin.users.reset_password']()}</h2>
			{#key resettingUser.id}<UserForm mode="reset-password" user={resettingUser} onsubmit={resetPassword} oncancel={() => (resettingUser = null)} />{/key}
		</section>
	{/if}

	<section class={panelClass} aria-labelledby="list-heading" aria-busy={users.status === 'loading'}>
		<h2 id="list-heading" class="text-xl font-semibold">{m['admin.users.heading']()}</h2>
		<form role="search" aria-label={m['admin.users.search']()} class="flex flex-wrap items-end gap-2" onsubmit={search}>
			<label class="space-y-1">
				<span class="block text-sm font-medium">{m['admin.users.search_category']()}</span>
				<select class={inputClass} bind:value={category} disabled={busy}>
					<option value="all">{m['admin.users.search_all']()}</option>
					<option value="username">{m['admin.users.username_label']()}</option>
					<option value="display_name">{m['admin.users.display_name_label']()}</option>
					<option value="role">{m['admin.users.role_label']()}</option>
					<option value="locale">{m['admin.users.locale_label']()}</option>
				</select>
			</label>
			<label class="min-w-48 flex-1 space-y-1">
				<span class="sr-only">{m['admin.users.search']()}</span>
				<input type="search" class={`${inputClass} w-full`} bind:value={query} disabled={busy} placeholder={m['admin.users.selector.search_placeholder']()} />
			</label>
			<button class={primaryButton} type="submit" disabled={busy}>{m['admin.users.search']()}</button>
		</form>
		{#if selected.length > 0}
			<div class="flex flex-wrap items-center gap-2" role="toolbar" aria-label={m['admin.users.actions']()}>
				<span class="text-sm">{m['admin.users.selected_count']({ count: selected.length })}</span>
				<button type="button" class={smallSecondaryButton} disabled={busy || !single} onclick={() => (editingUser = single)}>{m['admin.users.edit']()}</button>
				<button type="button" class={smallSecondaryButton} disabled={busy || !single} onclick={() => (resettingUser = single)}>{m['admin.users.reset_password']()}</button>
				<button type="button" class={smallSecondaryButton} disabled={busy || !selected.some((user) => user.disabled)} onclick={() => bulk('enable')}>{m['admin.users.enable']()}</button>
				<button type="button" class={smallSecondaryButton} disabled={busy || !selected.some((user) => !user.disabled)} onclick={() => bulk('disable')}>{m['admin.users.disable']()}</button>
				<button type="button" class={smallDangerButton} disabled={busy} onclick={() => bulk('revoke')}>{m['ux8.revoke']()}</button>
				<button type="button" class={smallDangerButton} disabled={busy} onclick={() => bulk('delete')}>{m['admin.users.delete']()}</button>
			</div>
		{/if}
		{#if users.status === 'error'}
			<AdminAlert message={translate(adminErrorKey(users.error, 'load'))} error={users.error} onretry={() => users.retry()} />
		{:else if users.status !== 'ready'}
			<p class="text-slate-600" role="status">{m['admin.users.list_loading']()}</p>
		{:else if users.empty}
			<p class="text-slate-600">{m['admin.users.list_empty']()}</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-left text-sm">
					<thead class="border-b border-slate-200 text-slate-600"><tr>
						<th scope="col" class="py-2 pr-4">
							<div class="flex items-center gap-2">
								<input type="checkbox" aria-label={m['admin.users.select_all']()} checked={allSelected}
									indeterminate={selected.length > 0 && !allSelected} disabled={busy}
									onchange={(event) => (selectedIDs = event.currentTarget.checked ? users.items.map((user) => user.id) : [])} />
								#
							</div>
						</th>
						<th scope="col" class="py-2 pr-4">{m['admin.users.username_label']()}</th>
						<th scope="col" class="py-2 pr-4">{m['admin.users.display_name_label']()}</th>
						<th scope="col" class="py-2 pr-4">{m['admin.users.role_label']()}</th>
						<th scope="col" class="py-2 pr-4">{m['admin.users.locale_label']()}</th>
						<th scope="col" class="py-2 pr-4">{m['ux8.status']()}</th>
						<th scope="col" class="py-2 pr-4">{m['admin.users.created_label']()}</th>
						<th scope="col" class="py-2 pr-4">{m['admin.users.updated_label']()}</th>
					</tr></thead>
					<tbody>
						{#each users.items as user, index (user.id)}
							<tr class={`border-b border-slate-100 ${selectedIDs.includes(user.id) ? 'bg-slate-50' : ''}`}>
								<td class="py-2 pr-4"><div class="flex items-center gap-2">
									<input type="checkbox" aria-label={m['admin.users.select_user']({ username: user.username })}
										checked={selectedIDs.includes(user.id)} disabled={busy} onchange={(event) => select(user.id, event.currentTarget.checked)} />
									<span>{index + 1}</span>
								</div></td>
								<td class="py-2 pr-4 font-mono">{user.username}</td>
								<td class="py-2 pr-4">{user.display_name || '—'}</td>
								<td class="py-2 pr-4">{user.role === 'admin' ? m['admin.users.role_admin']() : m['admin.users.role_user']()}</td>
								<td class="py-2 pr-4">{user.locale === 'zh' ? m['admin.users.locale_zh']() : m['admin.users.locale_en']()}</td>
								<td class="py-2 pr-4">{user.disabled ? m['admin.users.status_disabled']() : m['admin.users.status_enabled']()}</td>
								<td class="py-2 pr-4">{formatTimestamp(user.created_at)}</td>
								<td class="py-2 pr-4">{formatTimestamp(user.updated_at)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<PagerFooter pager={users} loadMoreLabel={m['admin.users.load_more']()} />
		{/if}
	</section>
	<section class={panelClass} aria-labelledby="admin-accounts-heading">
		<h2 id="admin-accounts-heading" class="text-xl font-semibold">{m['admin.accounts.heading']()}</h2>
		<p class="text-slate-700">{m['admin.accounts.cli']()}</p>
		<ul class="list-disc space-y-1 pl-6 text-sm text-slate-700">
			<li><code class="rounded bg-slate-100 px-1">pandalibrary user create --username &lt;name&gt;</code></li>
			<li><code class="rounded bg-slate-100 px-1">pandalibrary user reset-password --username &lt;name&gt;</code></li>
		</ul>
		<p class="text-sm text-slate-600">{m['admin.accounts.ids']()}</p>
	</section>
</section>
