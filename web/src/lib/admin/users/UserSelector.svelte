<script lang="ts">
	import { showLoadingAfterDelay } from '#lib/ui/deferred.js';
	import { onDestroy, tick, untrack } from 'svelte';
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
		searchable?: boolean;
		onsubmit: (user: User) => Promise<string | null>;
	}

	let { idPrefix, label, submitLabel, busyLabel, resetOnSuccess = false, searchable = false, onsubmit }: Props = $props();
	const users = new CursorPager<User>();
	let query = $state('');
	let searchText = $state('');
	let selected = $state('');
	let busy = $state(false);
	let error = $state('');
	let open = $state(false);
	let active = $state(-1);
	let root = $state<HTMLDivElement | null>(null);
	let searchInput = $state<HTMLInputElement | null>(null);

	$effect(() => {
		const q = searchable ? query.trim() : '';
		untrack(() => {
			selected = '';
			error = '';
			active = -1;
			void users.reset((cursor, signal) => listAdminUsers({ cursor, q, limit: 25, signal }));
		});
	});
	onDestroy(() => users.dispose());

	function userLabel(user: User) {
		return `${user.username}${user.display_name ? ` — ${user.display_name}` : ''} (#${user.id})${user.disabled ? ` — ${m['admin.users.status_disabled']()}` : ''}`;
	}

	function choose(user: User) {
		if (busy || users.status !== 'ready' || user.role === 'admin') return;
		selected = String(user.id);
		searchText = userLabel(user);
		error = '';
		open = false;
		active = -1;
	}

	async function moveActive(direction: number, edge = false) {
		open = true;
		const enabled = users.items.map((user, index) => user.role === 'admin' ? -1 : index).filter((index) => index >= 0);
		if (!enabled.length) return;
		const current = enabled.indexOf(active);
		const next = edge ? (direction > 0 ? enabled.length - 1 : 0)
			: current < 0 ? (direction > 0 ? 0 : enabled.length - 1)
			: (current + direction + enabled.length) % enabled.length;
		active = enabled[next];
		await tick();
		document.getElementById(`${idPrefix}-option-${users.items[active]?.id}`)?.scrollIntoView({ block: 'nearest' });
	}

	function searchKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			void moveActive(event.key === 'ArrowDown' ? 1 : -1);
		} else if (open && (event.key === 'Home' || event.key === 'End')) {
			event.preventDefault();
			void moveActive(event.key === 'End' ? 1 : -1, true);
		} else if (open && event.key === 'Enter' && active >= 0) {
			event.preventDefault();
			const user = users.items[active];
			if (user) choose(user);
		}
	}

	function closeOutside(event: PointerEvent) {
		if (open && !root?.contains(event.target as Node)) open = false;
	}

	function escapeDropdown(event: KeyboardEvent) {
		if (open && event.key === 'Escape' && root?.contains(event.target as Node)) {
			event.preventDefault();
			event.stopPropagation();
			searchInput?.focus();
			open = false;
		}
	}

	function focusOut(event: FocusEvent) {
		if (!event.relatedTarget && users.loadingMore) {
			searchInput?.focus();
			return;
		}
		if (!root?.contains(event.relatedTarget as Node | null)) open = false;
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy || users.status !== 'ready') return;
		const user = users.items.find((item) => String(item.id) === selected);
		if (!user || (searchable && user.role === 'admin')) {
			error = m['ux8.choose_user']();
			if (searchable) searchInput?.focus();
			else document.getElementById(`${idPrefix}-user`)?.focus();
			return;
		}
		error = '';
		busy = true;
		try {
			error = (await onsubmit(user)) ?? '';
			if (!error && resetOnSuccess) {
				selected = '';
				searchText = '';
				query = '';
			}
		} catch (cause) {
			console.error('User selection failed', cause);
			error = m['ux8.change_failed']();
		} finally {
			busy = false;
		}
	}
</script>

<svelte:document onpointerdown={closeOutside} onkeydown={escapeDropdown} />

{#if searchable}
	<form class="space-y-3" onsubmit={submit}>
		<div bind:this={root} class="relative" role="group" aria-label={label} onfocusout={focusOut}>
			<label for={`${idPrefix}-search`} class="mb-1 block text-sm font-medium">{m['admin.users.search']()}</label>
			<input bind:this={searchInput} id={`${idPrefix}-search`} type="search" role="combobox" class={`${inputClass} w-full`}
				bind:value={searchText} placeholder={m['admin.users.selector.search_placeholder']()} disabled={busy}
				aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={open} aria-controls={`${idPrefix}-user`}
				aria-activedescendant={open && active >= 0 && users.items[active] ? `${idPrefix}-option-${users.items[active].id}` : undefined}
				aria-describedby={error ? `${idPrefix}-error` : undefined} aria-invalid={error ? 'true' : 'false'}
				onfocus={() => { open = true; }} onclick={() => { open = true; }}
				oninput={(event) => {
					searchText = event.currentTarget.value;
					query = event.currentTarget.value;
					selected = '';
					active = -1;
					open = true;
				}}
				onkeydown={searchKeydown} />
			{#if open}
				<div role="presentation" class="absolute inset-x-0 top-full z-30 mt-1 rounded-md border border-slate-300 bg-white p-2 shadow-lg"
					onpointerdown={(event) => {
						if ((event.target as Element).closest('button')) event.preventDefault();
					}}>
					{#if users.status === 'error'}
						<AdminAlert message={translate(adminErrorKey(users.error, 'load'))} error={users.error} onretry={() => users.retry()} />
					{:else}
						<div id={`${idPrefix}-user`} role="listbox" aria-label={label} aria-busy={users.status !== 'ready'}
							class="max-h-60 overflow-y-auto overscroll-contain"
							onscroll={(event) => {
								const list = event.currentTarget;
								if (list.scrollTop + list.clientHeight >= list.scrollHeight - 4 && users.hasMore) void users.loadMore();
							}}>
							{#each users.items as user, index (user.id)}
								<button type="button" role="option" id={`${idPrefix}-option-${user.id}`} tabindex="-1"
									aria-selected={selected === String(user.id)} aria-disabled={user.role === 'admin'}
									disabled={busy || user.role === 'admin'}
									class={`block w-full rounded-sm px-3 py-2 text-left text-sm hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 ${active === index || selected === String(user.id) ? 'bg-emerald-50 text-emerald-900' : ''}`}
									onpointerdown={(event) => event.preventDefault()} onclick={() => choose(user)}>{userLabel(user)}</button>
							{/each}
						</div>
						{#if users.status !== 'ready'}<p use:showLoadingAfterDelay class="p-2 text-sm text-slate-600" role="status">{m['admin.users.selector.loading']()}</p>{/if}
						{#if users.empty}<p class="p-2 text-sm text-slate-600" role="status">{m['admin.users.selector.empty']()}</p>{/if}
						<PagerFooter pager={users} loadMoreLabel={m['admin.users.load_more']()} />
					{/if}
				</div>
			{/if}
		</div>
		{#if error}<p id={`${idPrefix}-error`} class="text-sm text-red-700" role="alert">{error}</p>{/if}
		<button type="submit" class={primaryButton} disabled={busy || users.status !== 'ready' || !selected}>
			{busy ? busyLabel : submitLabel}
		</button>
	</form>
{:else if users.status === 'error'}
	<AdminAlert message={translate(adminErrorKey(users.error, 'load'))} error={users.error} onretry={() => users.retry()} />
{:else}
	<form class="space-y-3" onsubmit={submit}>
		<label for={`${idPrefix}-user`} class="block text-sm font-medium text-slate-700">{label}</label>
		<select id={`${idPrefix}-user`} bind:value={selected} class={inputClass} disabled={busy || users.status !== 'ready'}
			aria-describedby={error ? `${idPrefix}-error` : undefined} aria-invalid={error ? 'true' : 'false'}>
			<option value="">{users.status === 'ready' ? m['admin.users.selector.label']() : m['admin.users.selector.loading']()}</option>
			{#each users.items as user (user.id)}
				<option value={String(user.id)}>{userLabel(user)}</option>
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
