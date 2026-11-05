<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import PagerFooter from '#lib/admin/PagerFooter.svelte';
	import { listAdminUsers } from '#lib/admin/api.js';
	import { adminErrorKey } from '#lib/admin/form.js';
	import type { User } from '#lib/admin/types.js';
	import { inputClass, primaryButton } from '#lib/admin/ui.js';
	import { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { translate } from '#lib/paging/translate.js';

	interface Props {
		idPrefix: string;
		label: string;
		submitLabel: string;
		busyLabel: string;
		resetOnSuccess?: boolean;
		onsubmit: (user: User) => Promise<string | null>;
	}

	let { idPrefix, label, submitLabel, busyLabel, resetOnSuccess = false, onsubmit }: Props = $props();
	const users = new CursorPager<User>();
	let selected = $state('');
	let busy = $state(false);
	let error = $state('');

	onMount(() => { void users.reset((cursor, signal) => listAdminUsers({ cursor, limit: 25, signal })); });
	onDestroy(() => users.dispose());

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		const user = users.items.find((item) => String(item.id) === selected);
		if (!user) {
			error = m['ux8.choose_user']();
			document.getElementById(`${idPrefix}-user`)?.focus();
			return;
		}
		error = '';
		busy = true;
		try {
			error = (await onsubmit(user)) ?? '';
			if (!error && resetOnSuccess) selected = '';
		} catch (cause) {
			console.error('User selection failed', cause);
			error = m['ux8.change_failed']();
		} finally {
			busy = false;
		}
	}
</script>

{#if users.status === 'error'}
	<AdminAlert message={translate(adminErrorKey(users.error, 'load'))} error={users.error} onretry={() => users.retry()} />
{:else}
	<form class="space-y-3" onsubmit={submit}>
		<label for={`${idPrefix}-user`} class="block text-sm font-medium text-slate-700">{label}</label>
		<select id={`${idPrefix}-user`} bind:value={selected} class={inputClass} disabled={busy || users.status !== 'ready'}
			aria-describedby={error ? `${idPrefix}-error` : undefined} aria-invalid={error ? 'true' : 'false'}>
			<option value="">{users.status === 'ready' ? m['admin.users.selector.label']() : m['admin.users.selector.loading']()}</option>
			{#each users.items as user (user.id)}
				<option value={String(user.id)}>{user.username}{user.display_name ? ` — ${user.display_name}` : ''} (#{user.id}){user.disabled ? ` — ${m['admin.users.status_disabled']()}` : ''}</option>
			{/each}
		</select>
		{#if users.empty}<p class="text-sm text-slate-600">{m['admin.users.selector.empty']()}</p>{/if}
		{#if error}<p id={`${idPrefix}-error`} class="text-sm text-red-700" role="alert">{error}</p>{/if}
		<button type="submit" class={primaryButton} disabled={busy || users.status !== 'ready' || users.empty}>
			{busy ? busyLabel : submitLabel}
		</button>
	</form>
	<PagerFooter pager={users} loadMoreLabel={m['admin.users.load_more']()} />
{/if}
