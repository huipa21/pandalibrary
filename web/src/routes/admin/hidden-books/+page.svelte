<script lang="ts">
	import { onDestroy } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import IdForm from '#lib/admin/IdForm.svelte';
	import UserSelector from '#lib/admin/users/UserSelector.svelte';
	import PagerFooter from '#lib/admin/PagerFooter.svelte';
	import { hideBook, listHiddenBooks, unhideBook } from '#lib/admin/api.js';
	import { adminErrorKey } from '#lib/admin/form.js';
	import { formatTimestamp } from '#lib/admin/jobs.js';
	import type { HiddenEntry, User } from '#lib/admin/types.js';
	import { panelClass, smallDangerButton, smallSecondaryButton } from '#lib/admin/ui.js';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { translate } from '#lib/paging/translate.js';

	const hidden = new CursorPager<HiddenEntry>();
	let userID = $state<number | null>(null);
	let selectedUser = $state<User | null>(null);
	let notice = $state('');
	let error = $state('');
	let unhiding = $state<number | null>(null);

	onDestroy(() => hidden.dispose());

	async function selectUser(user: User): Promise<string | null> {
		userID = user.id;
		selectedUser = user;
		notice = '';
		error = '';
		void hidden.reset((cursor, signal) => listHiddenBooks(user.id, { cursor, signal }));
		return null;
	}

	function clearUser() {
		userID = null;
		selectedUser = null;
		notice = '';
		error = '';
		void hidden.reset(null);
	}

	async function hide(bookID: number): Promise<string | null> {
		const user = userID;
		if (user === null) return null;
		if (!window.confirm(m['admin.hidden.hide_confirm']({ book: bookID, user }))) return null;
		notice = '';
		error = '';
		try {
			await hideBook(user, bookID);
			if (userID !== user) return null;
			notice = m['admin.hidden.hidden']({ book: bookID, user });
			void hidden.reload();
			return null;
		} catch (cause) {
			if (userID !== user) return null;
			return translate(adminErrorKey(cause, 'hide'));
		}
	}

	async function unhide(entry: HiddenEntry) {
		const user = userID;
		if (user === null || unhiding !== null) return;
		if (!window.confirm(m['admin.hidden.unhide_confirm']({ book: entry.book_id, user }))) return;
		notice = '';
		error = '';
		unhiding = entry.book_id;
		try {
			await unhideBook(user, entry.book_id);
			if (userID !== user) return;
			notice = m['admin.hidden.unhidden']({ book: entry.book_id, user });
			void hidden.reload();
		} catch (cause) {
			if (userID === user) error = translate(adminErrorKey(cause, 'unhide'));
		} finally {
			unhiding = null;
		}
	}
</script>

<svelte:head>
	<title>{m['admin.hidden.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-8" aria-labelledby="hidden-heading">
	<header class="space-y-2">
		<h1 id="hidden-heading" class="text-3xl font-semibold tracking-tight">{m['admin.hidden.title']()}</h1>
		<p class="text-slate-600">{m['admin.hidden.description']()}</p>
	</header>

	<section class={panelClass} aria-labelledby="hidden-user-heading">
		<h2 id="hidden-user-heading" class="text-xl font-semibold">{m['admin.hidden.user_heading']()}</h2>
		<UserSelector
			idPrefix="hidden-user"
			label={m['admin.hidden.user_id']()}
			submitLabel={m['admin.hidden.show']()}
			busyLabel={m['admin.hidden.show']()}
			onsubmit={selectUser}
		/>
	</section>

	{#if userID !== null}
		<section class={panelClass} aria-labelledby="hidden-list-heading" aria-busy={hidden.status === 'loading'}>
			<div class="flex flex-wrap items-start justify-between gap-3">
				<h2 id="hidden-list-heading" class="text-xl font-semibold">{m['admin.hidden.list_heading']({ user: userID })}</h2>
				<button type="button" class={smallSecondaryButton} onclick={clearUser}>{m['admin.hidden.close']()}</button>
			</div>
			{#if selectedUser}<p class="text-sm text-slate-600">{m['ux8.selected_user']({ username: selectedUser.username, id: selectedUser.id })}</p>{/if}
			{#if hidden.status === 'error'}
				<AdminAlert message={translate(adminErrorKey(hidden.error, 'load_hidden'))} error={hidden.error} onretry={() => hidden.retry()} />
			{:else}
				<IdForm
					idPrefix="hide-book"
					label={m['admin.hidden.book_id']()}
					hint={m['admin.hidden.book_id_hint']()}
					submitLabel={m['admin.hidden.hide']()}
					busyLabel={m['admin.hidden.hiding']()}
					resetOnSuccess
					onsubmit={hide}
				/>
				{#if notice}<p class="text-sm text-green-700" role="status">{notice}</p>{/if}
				{#if error}<AdminAlert message={error} />{/if}
				{#if hidden.status !== 'ready'}
					<p class="text-slate-600" role="status">{m['admin.hidden.loading']()}</p>
				{:else if hidden.empty}
					<p class="text-slate-600">{m['admin.hidden.empty']()}</p>
				{:else}
					<div class="overflow-x-auto">
						<table class="w-full text-left text-sm">
							<thead class="border-b border-slate-200 text-slate-600">
								<tr>
									<th scope="col" class="py-2 pr-4 font-medium">{m['admin.hidden.book_column']()}</th>
									<th scope="col" class="py-2 pr-4 font-medium">{m['admin.hidden.by_column']()}</th>
									<th scope="col" class="py-2 pr-4 font-medium">{m['admin.hidden.created_column']()}</th>
									<th scope="col" class="py-2 font-medium"><span class="sr-only">{m['admin.actions']()}</span></th>
								</tr>
							</thead>
							<tbody>
								{#each hidden.items as entry (entry.book_id)}
									<tr class="border-b border-slate-100">
										<td class="py-2 pr-4 font-mono">{entry.book_id}</td>
										<td class="py-2 pr-4 font-mono">{entry.hidden_by ?? m['admin.hidden.by_unknown']()}</td>
										<td class="py-2 pr-4">{formatTimestamp(entry.created_at)}</td>
										<td class="py-2 text-right">
											<button type="button" class={smallDangerButton} disabled={unhiding !== null} onclick={() => unhide(entry)}>
												{unhiding === entry.book_id ? m['admin.hidden.unhiding']() : m['admin.hidden.unhide']()}<span class="sr-only"> {m['admin.hidden.book_label']({ book: entry.book_id })}</span>
											</button>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<PagerFooter pager={hidden} loadMoreLabel={m['admin.hidden.load_more']()} />
				{/if}
			{/if}
		</section>
	{/if}
</section>
