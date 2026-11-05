<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import PagerFooter from '#lib/admin/PagerFooter.svelte';
	import UserForm from '#lib/admin/UserForm.svelte';
	import { createUser, deleteUser, listAdminUsers, resetUserPassword, revokeUserCredentials, updateUser } from '#lib/admin/api.js';
	import { adminErrorKey, userPatch, type UserFormDraft } from '#lib/admin/form.js';
	import { formatTimestamp } from '#lib/admin/jobs.js';
	import type { User } from '#lib/admin/types.js';
	import { panelClass, primaryButton, smallDangerButton, smallSecondaryButton } from '#lib/admin/ui.js';
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
	const formOpen = $derived(creating || editingUser !== null || resettingUser !== null);

	onMount(() => { void users.reset((cursor, signal) => listAdminUsers({ cursor, signal })); });
	onDestroy(() => users.dispose());

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

	async function toggleEnabled(user: User) {
		if (actionInProgress || formOpen) return;
		const disabling = !user.disabled;
		const question = disabling
			? m['admin.users.form.disable_confirm']({ username: user.username, displayName: user.display_name })
			: m['ux8.enable_confirm']({ username: user.username });
		if (!window.confirm(question)) return;
		actionInProgress = true;
		notice = '';
		actionError = '';
		try {
			await updateUser(user.id, { disabled: disabling });
			notice = disabling ? m['admin.users.form.success_disabled']() : m['admin.users.form.success_enabled']();
			await users.reload();
		} catch (cause) {
			actionError = translate(adminErrorKey(cause, 'update'));
		} finally {
			actionInProgress = false;
		}
	}

	async function revoke(user: User) {
		if (actionInProgress || formOpen || !window.confirm(m['ux8.revoke_confirm']({ username: user.username }))) return;
		actionInProgress = true;
		notice = '';
		actionError = '';
		try {
			const self = user.id === currentAccount();
			await withSessionLock(async () => {
				await revokeUserCredentials(user.id);
				if (self) await deactivateOffline();
			});
			if (self) {
				window.location.assign('/login');
				return;
			}
			notice = m['ux8.revoked']();
		} catch (cause) {
			actionError = translate(adminErrorKey(cause, 'update'));
		} finally {
			actionInProgress = false;
		}
	}

	async function remove(user: User) {
		if (actionInProgress || formOpen ||
			!window.confirm(m['admin.users.form.delete_confirm']({ username: user.username, displayName: user.display_name }))) return;
		actionInProgress = true;
		notice = '';
		actionError = '';
		try {
			await deleteUser(user.id);
			notice = m['admin.users.form.success_deleted']();
			await users.reload();
		} catch (cause) {
			actionError = translate(adminErrorKey(cause, 'delete'));
		} finally {
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
						<th scope="col" class="py-2 pr-4">{m['admin.users.username_label']()}</th>
						<th scope="col" class="py-2 pr-4">{m['admin.users.display_name_label']()}</th>
						<th scope="col" class="py-2 pr-4">{m['admin.users.role_label']()}</th>
						<th scope="col" class="py-2 pr-4">{m['admin.users.locale_label']()}</th>
						<th scope="col" class="py-2 pr-4">{m['ux8.status']()}</th>
						<th scope="col" class="py-2 pr-4">{m['admin.users.created_label']()}</th>
						<th scope="col" class="py-2 pr-4">{m['admin.users.updated_label']()}</th>
						<th scope="col" class="py-2"><span class="sr-only">{m['admin.users.actions']()}</span></th>
					</tr></thead>
					<tbody>
						{#each users.items as user (user.id)}
							<tr class="border-b border-slate-100">
								<td class="py-2 pr-4 font-mono">{user.username}</td>
								<td class="py-2 pr-4">{user.display_name || '—'}</td>
								<td class="py-2 pr-4">{user.role === 'admin' ? m['admin.users.role_admin']() : m['admin.users.role_user']()}</td>
								<td class="py-2 pr-4">{user.locale === 'zh' ? m['admin.users.locale_zh']() : m['admin.users.locale_en']()}</td>
								<td class="py-2 pr-4">{user.disabled ? m['admin.users.status_disabled']() : m['admin.users.status_enabled']()}</td>
								<td class="py-2 pr-4">{formatTimestamp(user.created_at)}</td>
								<td class="py-2 pr-4">{formatTimestamp(user.updated_at)}</td>
								<td class="py-2"><div class="flex flex-wrap gap-2">
									<button type="button" class={smallSecondaryButton} disabled={formOpen || actionInProgress} onclick={() => (editingUser = user)}>
										{m['admin.users.edit']()}<span class="sr-only"> {user.username}</span>
									</button>
									<button type="button" class={smallSecondaryButton} disabled={formOpen || actionInProgress} onclick={() => toggleEnabled(user)}>
										{user.disabled ? m['admin.users.enable']() : m['admin.users.disable']()}<span class="sr-only"> {user.username}</span>
									</button>
									<button type="button" class={smallSecondaryButton} disabled={formOpen || actionInProgress} onclick={() => (resettingUser = user)}>
										{m['admin.users.reset_password']()}<span class="sr-only"> {user.username}</span>
									</button>
									<button type="button" class={smallDangerButton} disabled={formOpen || actionInProgress} onclick={() => revoke(user)}>
										{m['ux8.revoke']()}<span class="sr-only"> {user.username}</span>
									</button>
									<button type="button" class={smallDangerButton} disabled={formOpen || actionInProgress} onclick={() => remove(user)}>
										{m['admin.users.delete']()}<span class="sr-only"> {user.username}</span>
									</button>
								</div></td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<PagerFooter pager={users} loadMoreLabel={m['admin.users.load_more']()} />
		{/if}
	</section>
</section>
