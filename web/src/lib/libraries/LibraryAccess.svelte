<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import PagerFooter from '#lib/admin/PagerFooter.svelte';
	import UserSelector from '#lib/admin/users/UserSelector.svelte';
	import { grantLibraryAccess, listLibraryAccess, revokeLibraryAccess } from '#lib/admin/api.js';
	import { adminErrorKey } from '#lib/admin/form.js';
	import { formatTimestamp } from '#lib/admin/jobs.js';
	import type { AccessEntry, Library } from '#lib/admin/types.js';
	import { smallDangerButton, warningBox } from '#lib/admin/ui.js';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { translate } from '#lib/paging/translate.js';

	let { library }: { library: Library } = $props();
	const access = new CursorPager<AccessEntry>();
	let notice = $state('');
	let error = $state('');
	let revoking = $state<number | null>(null);

	$effect(() => {
		const id = library.id;
		untrack(() => {
			notice = '';
			error = '';
			void access.reset((cursor, signal) => listLibraryAccess(id, { cursor, signal }));
		});
	});
	onDestroy(() => access.dispose());

	async function grant(userID: number): Promise<string | null> {
		const current = library;
		notice = '';
		error = '';
		try {
			await grantLibraryAccess(current.id, userID);
			notice = m['admin.access.granted']({ user: userID, library: current.name });
			void access.reload();
			return null;
		} catch (cause) {
			return translate(adminErrorKey(cause, 'grant'));
		}
	}

	async function revoke(entry: AccessEntry) {
		if (revoking !== null) return;
		const current = library;
		if (!window.confirm(m['admin.access.revoke_confirm']({ user: entry.user_id, library: current.name }))) return;
		notice = '';
		error = '';
		revoking = entry.user_id;
		try {
			await revokeLibraryAccess(current.id, entry.user_id);
			notice = m['admin.access.revoked']({ user: entry.user_id, library: current.name });
			void access.reload();
		} catch (cause) {
			error = translate(adminErrorKey(cause, 'revoke'));
		} finally {
			revoking = null;
		}
	}
</script>

<section class="card space-y-4 p-5" aria-labelledby="library-access-heading" aria-busy={access.status === 'loading'}>
	<h2 id="library-access-heading" class="text-xl font-semibold">{m['admin.libraries.manage_access']()}</h2>
	<p class={warningBox}>{m['admin.access.admin_note']()}</p>
	<UserSelector idPrefix="library-grant-user" searchable label={m['admin.access.user_id']()}
		submitLabel={m['admin.access.grant']()} busyLabel={m['admin.access.granting']()} resetOnSuccess onsubmit={(user) => grant(user.id)} />
	{#if notice}<p class="text-sm text-green-700" role="status">{notice}</p>{/if}
	{#if error}<AdminAlert message={error} />{/if}
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
