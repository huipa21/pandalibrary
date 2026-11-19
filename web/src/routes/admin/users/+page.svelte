<script lang="ts">
	import { showLoadingAfterDelay } from '#lib/ui/deferred.js';
	import { confirmAction } from '#lib/shell/confirmation.js';
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import PagerFooter from '#lib/admin/PagerFooter.svelte';
	import UserDialog from '#lib/admin/UserDialog.svelte';
	import { createUser, deleteUser, listAdminUsers, resetUserPassword, revokeUserCredentials, updateUser } from '#lib/admin/api.js';
	import { adminErrorKey, userPatch, type UserFormDraft } from '#lib/admin/form.js';
	import { formatTimestamp } from '#lib/admin/jobs.js';
	import type { User } from '#lib/admin/types.js';
	import { panelClass, smallDangerButton, smallSecondaryButton } from '#lib/admin/ui.js';
	import Icon from '#lib/bookview/Icon.svelte';
	import { controlIconClass, primaryIconControlClass } from '#lib/catalog/filter-styles.js';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { translate } from '#lib/paging/translate.js';
	import SearchField from '#lib/search/SearchField.svelte';
	import { currentAccount, deactivateOffline } from '#lib/sync/client.js';
	import { withSessionLock } from '#lib/sync/engine.js';

	const users = new CursorPager<User>();
	let creating = $state(false);
	let editingUser = $state<User | null>(null);
	let actionInProgress = $state(false);
	let notice = $state('');
	let actionError = $state('');
	let query = $state('');
	let showHelp = $state(false);
	let selectedIDs = $state<number[]>([]);
	const selected = $derived(users.items.filter((user) => selectedIDs.includes(user.id)));
	const single = $derived(selected.length === 1 ? selected[0] : null);
	const allSelected = $derived(users.items.length > 0 && selected.length === users.items.length);
	const dialogOpen = $derived(creating || editingUser !== null);
	const busy = $derived(dialogOpen || actionInProgress);
	const bulkToggle = $derived(selected.length > 0 && selected.every((user) => user.disabled) ? 'enable' : 'disable');
	const bulkToggleLabel = $derived(bulkToggle === 'enable' ? m['admin.users.enable']() : m['admin.users.disable']());
	const bulkToggleDisabled = $derived(bulkToggle === 'enable'
		? !selected.some((user) => user.disabled)
		: !selected.some((user) => !user.disabled));

	onMount(() => { void users.reset((cursor, signal) => listAdminUsers({ cursor, signal })); });
	onDestroy(() => users.dispose());

	function search(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		const q = query.trim();
		selectedIDs = [];
		void users.reset((cursor, signal) => listAdminUsers({ cursor, signal, q }));
	}

	function select(id: number, checked: boolean) {
		selectedIDs = checked ? [...selectedIDs, id] : selectedIDs.filter((value) => value !== id);
	}

	async function createAccount(input: UserFormDraft): Promise<string | null> {
		notice = '';
		actionError = '';
		try {
			await createUser({
				username: input.username,
				displayName: input.displayName,
				email: input.email ?? '',
				password: input.password,
				role: input.role
			});
			notice = m['admin.users.form.success_create']();
			await users.reload();
			return null;
		} catch (cause) {
			return translate(adminErrorKey(cause, 'create'));
		}
	}

	async function updateAccount(input: UserFormDraft): Promise<string | null> {
		const user = editingUser;
		if (!user) return m['ux8.change_failed']();
		const result = userPatch(user, input);
		if (!result.ok && (result.error !== 'no_changes' || !input.password)) {
			return translate(`admin.users.form.error.${result.error}`);
		}
		const patch = result.ok ? result.patch : {};
		notice = '';
		actionError = '';
		let failing: 'reset' | 'update' = input.password ? 'reset' : 'update';
		try {
			const self = user.id === currentAccount();
			if (input.password) {
				await withSessionLock(async () => {
					await resetUserPassword(user.id, input.password);
					if (self) await deactivateOffline();
				});
			}
			failing = 'update';
			if (Object.keys(patch).length > 0) await updateUser(user.id, patch);
			if (self && input.password) {
				window.location.assign('/login');
				return null;
			}
			if (self) {
				window.location.reload();
				return null;
			}
			notice = input.password
				? m['admin.users.form.success_password_reset']()
				: m['admin.users.form.success_update']();
			await users.reload();
			return null;
		} catch (cause) {
			return translate(adminErrorKey(cause, failing));
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
		if (!await confirmAction(m['admin.users.bulk_confirm']({
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
	<h1 id="users-heading" class="sr-only">{m['admin.users.heading']()}</h1>
	{#if notice}<p class="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800" role="status">{notice}</p>{/if}
	{#if actionError}<AdminAlert message={actionError} />{/if}

	<UserDialog open={creating} mode="create" onclose={() => (creating = false)} onsave={createAccount} />
	{#if editingUser}
		<UserDialog open mode="edit" user={editingUser} onclose={() => (editingUser = null)} onsave={updateAccount} />
	{/if}

	<section class={panelClass} aria-busy={users.status === 'loading'}>
		<div class="flex flex-wrap items-center gap-2">
			<form role="search" aria-label={m['admin.users.search']()} class="flex min-w-0 w-full max-w-xs sm:max-w-sm" onsubmit={search}>
				<SearchField
					id="admin-users-search"
					name="q"
					class="min-w-0 flex-1"
					label={m['admin.users.search']()}
					buttonLabel={m['admin.users.search']()}
					placeholder={m['admin.users.selector.search_placeholder']()}
					bind:value={query}
					disabled={busy}
				/>
			</form>
			<div class="ml-auto flex items-center gap-2">
				<button
					type="button"
					class="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 app-focus-ring"
					aria-label={m['admin.accounts.heading']()}
					title={m['admin.accounts.heading']()}
					aria-expanded={showHelp}
					aria-controls="users-help"
					onclick={() => (showHelp = !showHelp)}
				>
					<Icon name="info" class={controlIconClass} />
				</button>
				<button
					type="button"
					class={primaryIconControlClass}
					aria-label={m['admin.users.create_label']()}
					title={m['admin.users.create_label']()}
					disabled={busy}
					onclick={() => (creating = true)}
				>
					<Icon name="plus" class={controlIconClass} />
				</button>
			</div>
		</div>
		{#if showHelp}
			<div id="users-help" class="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
				<p>{m['admin.accounts.cli']()}</p>
				<ul class="list-disc space-y-1 pl-6">
					<li><code class="rounded bg-slate-100 px-1">pandalibrary user create --username &lt;name&gt;</code></li>
					<li><code class="rounded bg-slate-100 px-1">pandalibrary user reset-password --username &lt;name&gt;</code></li>
				</ul>
				<p>{m['admin.accounts.ids']()}</p>
			</div>
		{/if}
		{#if selected.length > 0}
			<div class="flex flex-wrap items-center gap-2" role="toolbar" aria-label={m['admin.users.actions']()}>
				<span class="text-sm">{m['admin.users.selected_count']({ count: selected.length })}</span>
				<button type="button" class={smallSecondaryButton} disabled={busy || !single} onclick={() => (editingUser = single)}>{m['admin.users.edit']()}</button>
				<button type="button" class={smallSecondaryButton} disabled={busy || bulkToggleDisabled} onclick={() => bulk(bulkToggle)}>{bulkToggleLabel}</button>
				<button type="button" class={smallDangerButton} disabled={busy} onclick={() => bulk('revoke')}>{m['ux8.revoke']()}</button>
				<button type="button" class={smallDangerButton} disabled={busy} onclick={() => bulk('delete')}>{m['admin.users.delete']()}</button>
			</div>
		{/if}
		{#if users.status === 'error'}
			<AdminAlert message={translate(adminErrorKey(users.error, 'load'))} error={users.error} onretry={() => users.retry()} />
		{:else if users.status !== 'ready'}
			<p use:showLoadingAfterDelay class="text-slate-600" role="status">{m['admin.users.list_loading']()}</p>
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
						<th scope="col" class="py-2 pr-4">{m['admin.users.email_label']()}</th>
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
								<td class="py-2 pr-4">{user.email || '—'}</td>
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
</section>
