<script lang="ts">
	import { onDestroy } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import PagerFooter from '#lib/admin/PagerFooter.svelte';
	import UserForm from '#lib/admin/UserForm.svelte';
	import { createUser, deleteUser, listAdminUsers, resetUserPassword, revokeUserCredentials, revokeUserSessions, updateUser } from '#lib/admin/api.js';
	import { adminErrorKey, type UserFormDraft } from '#lib/admin/form.js';
	import { formatTimestamp } from '#lib/admin/jobs.js';
	import type { User } from '#lib/admin/types.js';
	import { panelClass, primaryButton, smallDangerButton, smallSecondaryButton } from '#lib/admin/ui.js';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { translate } from '#lib/paging/translate.js';

	const users = new CursorPager<User>();
	let creating = $state(false);
	let editingUser = $state<User | null>(null);
	let selectedUserForAction = $state<User | null>(null);
	let actionInProgress = $state('');
	let notice = $state('');
	let actionError = $state('');
	let loadError = $state('');

	onDestroy(() => users.dispose());

	async function loadUsers() {
		loadError = '';
		await users.reset((cursor, signal) => listAdminUsers({ cursor, signal }));
	}

	async function handleCreateUser(input: Partial<UserFormDraft>): Promise<string | null> {
		notice = '';
		actionError = '';
		try {
			await createUser(input.username ?? '', input.displayName ?? '', input.password ?? '', input.role ?? 'user', input.locale ?? 'en');
			notice = m['admin.users.form.success_create']();
			creating = false;
			await users.reload();
			return null;
		} catch (cause) {
			return translate(adminErrorKey(cause, 'create'));
		}
	}

	async function handleUpdateUser(input: Partial<{ username: string; displayName: string; role: string; locale: string }>): Promise<string | null> {
		if (!editingUser) return null;
		notice = '';
		actionError = '';
		try {
			await updateUser(editingUser.id, {
				username: input.username,
				display_name: input.displayName,
				role: input.role,
				locale: input.locale
			});
			notice = m['admin.users.form.success_update']();
			editingUser = null;
			await users.reload();
			return null;
		} catch (cause) {
			return translate(adminErrorKey(cause, 'update'));
		}
	}

	async function handleResetPassword(password: string): Promise<string | null> {
		if (!selectedUserForAction) return null;
		notice = '';
		actionError = '';
		try {
			await resetUserPassword(selectedUserForAction.id, password);
			notice = m['admin.users.form.success_password_reset']();
			selectedUserForAction = null;
			return null;
		} catch (cause) {
			return translate(adminErrorKey(cause, 'reset'));
		}
	}

	async function toggleEnabled(user: User) {
		if (actionInProgress) return;
		const newState = !user.disabled;
		const confirmMsg = newState
			? m['admin.users.form.disable_confirm']({ username: user.username, displayName: user.display_name })
			: m['admin.users.form.success_enabled']();
		
		if (!window.confirm(confirmMsg)) return;

		notice = '';
		actionError = '';
		actionInProgress = 'toggle';
		try {
			await updateUser(user.id, { disabled: newState });
			notice = newState ? m['admin.users.form.success_disabled']() : m['admin.users.form.success_enabled']();
			await users.reload();
		} catch (cause) {
			actionError = translate(adminErrorKey(cause, 'update'));
		} finally {
			actionInProgress = '';
		}
	}

	async function revokeSessions(user: User) {
		if (actionInProgress) return;
		if (!window.confirm(m['admin.users.form.success_revoke_sessions']())) return;

		notice = '';
		actionError = '';
		actionInProgress = 'revoke-sessions';
		try {
			await revokeUserSessions(user.id);
			notice = m['admin.users.form.success_revoke_sessions']();
			await users.reload();
		} catch (cause) {
			actionError = translate(adminErrorKey(cause, 'revoke'));
		} finally {
			actionInProgress = '';
		}
	}

	async function revokeCredentials(user: User) {
		if (actionInProgress) return;
		if (!window.confirm(m['admin.users.form.success_revoke_credentials']())) return;

		notice = '';
		actionError = '';
		actionInProgress = 'revoke-creds';
		try {
			await revokeUserCredentials(user.id);
			notice = m['admin.users.form.success_revoke_credentials']();
			await users.reload();
		} catch (cause) {
			actionError = translate(adminErrorKey(cause, 'revoke'));
		} finally {
			actionInProgress = '';
		}
	}

	async function deleteUserAction(user: User) {
		if (actionInProgress) return;
		const confirmMsg = m['admin.users.form.delete_confirm']({ username: user.username, displayName: user.display_name });
		if (!window.confirm(confirmMsg)) return;

		notice = '';
		actionError = '';
		actionInProgress = 'delete';
		try {
			await deleteUser(user.id);
			notice = m['admin.users.form.success_deleted']();
			await users.reload();
		} catch (cause) {
			actionError = translate(adminErrorKey(cause, 'delete'));
		} finally {
			actionInProgress = '';
		}
	}

	onDestroy(() => users.dispose());
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
		<button type="button" class={primaryButton} disabled={creating || editingUser !== null} onclick={() => (creating = true)}>
			{m['admin.users.create_label']()}
		</button>
	</header>

	{#if notice}
		<p class="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800" role="status">{notice}</p>
	{/if}

	{#if actionError}
		<AdminAlert message={actionError} />
	{/if}

	{#if creating}
		<section class={panelClass} aria-labelledby="create-heading">
			<h2 id="create-heading" class="text-xl font-semibold">{m['admin.users.form.create_title']()}</h2>
			<UserForm mode="create" onsubmit={handleCreateUser} oncancel={() => (creating = false)} />
		</section>
	{:else if editingUser}
		<section class={panelClass} aria-labelledby="edit-heading">
			<h2 id="edit-heading" class="text-xl font-semibold">{m['admin.users.form.edit_title']()}</h2>
			{#key editingUser.id}
				<UserForm mode="edit" user={editingUser} onsubmit={handleUpdateUser} oncancel={() => (editingUser = null)} />
			{/key}
		</section>
	{:else if selectedUserForAction && selectedUserForAction.id}
		<section class={panelClass} aria-labelledby="reset-heading">
			<h2 id="reset-heading" class="text-xl font-semibold">{m['admin.users.form.password_new']()}</h2>
			{#key selectedUserForAction.id}
				<UserForm mode="reset-password" user={selectedUserForAction} onsubmit={(input) => handleResetPassword(input.password ?? '')} oncancel={() => (selectedUserForAction = null)} />
			{/key}
		</section>
	{/if}

	<section class={panelClass} aria-labelledby="list-heading" aria-busy={users.status === 'loading'}>
		<h2 id="list-heading" class="text-xl font-semibold">{m['admin.users.heading']()}</h2>

		{#if loadError}
			<AdminAlert message={loadError} error={users.error} onretry={loadUsers} />
		{:else if users.status === 'error'}
			<AdminAlert message={translate(adminErrorKey(users.error, 'load'))} error={users.error} onretry={() => users.retry()} />
		{:else if users.status === 'ready' && users.empty}
			<p class="text-slate-600">{m['admin.users.list_empty']()}</p>
		{:else if users.status !== 'ready'}
			<p class="text-slate-600" role="status">{m['admin.users.list_loading']()}</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-left text-sm">
					<thead class="border-b border-slate-200 text-slate-600">
						<tr>
							<th scope="col" class="py-2 pr-4 font-medium">{m['admin.users.username_label']()}</th>
							<th scope="col" class="py-2 pr-4 font-medium">{m['admin.users.display_name_label']()}</th>
							<th scope="col" class="py-2 pr-4 font-medium">{m['admin.users.role_label']()}</th>
							<th scope="col" class="py-2 pr-4 font-medium">{m['admin.users.created_label']()}</th>
							<th scope="col" class="py-2 font-medium"><span class="sr-only">{m['admin.users.actions']()}</span></th>
						</tr>
					</thead>
					<tbody>
						{#each users.items as user (user.id)}
							<tr class="border-b border-slate-100">
								<td class="py-2 pr-4 font-mono">{user.username}</td>
								<td class="py-2 pr-4">{user.display_name || '—'}</td>
								<td class="py-2 pr-4">
									{user.role === 'admin' ? m['admin.users.role_admin']() : m['admin.users.role_user']()}
									{#if user.disabled}<span class="text-slate-500"> ({m['admin.users.status_disabled']()})</span>{/if}
								</td>
								<td class="py-2 pr-4">{formatTimestamp(user.created_at)}</td>
								<td class="py-2">
									<div class="flex gap-2">
										<button type="button" class={smallSecondaryButton} disabled={actionInProgress !== ''} onclick={() => (editingUser = user)}>
											{m['admin.users.edit']()}
										</button>
										<button
											type="button"
											class={smallSecondaryButton}
											disabled={actionInProgress !== ''}
											onclick={() => toggleEnabled(user)}
										>
											{user.disabled ? m['admin.users.enable']() : m['admin.users.disable']()}
										</button>
										<button type="button" class={smallSecondaryButton} disabled={actionInProgress !== ''} onclick={() => (selectedUserForAction = user)}>
											{m['admin.users.reset_password']()}
										</button>
										<button type="button" class={smallDangerButton} disabled={actionInProgress !== ''} onclick={() => revokeSessions(user)}>
											{m['admin.users.revoke_sessions']()}
										</button>
										<button type="button" class={smallDangerButton} disabled={actionInProgress !== ''} onclick={() => revokeCredentials(user)}>
											{m['admin.users.revoke_credentials']()}
										</button>
										<button type="button" class={smallDangerButton} disabled={actionInProgress !== ''} onclick={() => deleteUserAction(user)}>
											{m['admin.users.delete']()}
										</button>
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<PagerFooter pager={users} loadMoreLabel={m['admin.users.load_more']()} />
		{/if}
	</section>
</section>
