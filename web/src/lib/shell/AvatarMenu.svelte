<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import HeaderMenu from './HeaderMenu.svelte';
	import { initials } from './initials.js';

	interface Props {
		pathname: string;
		viewer: { username: string; display_name: string; role?: string };
		onlogout: () => void;
	}

	let { pathname, viewer, onlogout }: Props = $props();
	const displayName = $derived(viewer.display_name || viewer.username);
</script>

<HeaderMenu menuId="avatar-menu" popup="menu" label={m['hm1.account.button']()}>
	{#snippet trigger({ expanded, controls, popup, toggle, onkeydown })}
		<button
			type="button"
			class="avatar-trigger shell-icon-button size-9"
			aria-label={m['hm1.account.button']()}
			title={m['hm1.account.button']()}
			aria-haspopup={popup}
			aria-expanded={expanded}
			aria-controls={controls}
			onclick={toggle}
			onkeydown={onkeydown}
		>
			<span aria-hidden="true" class="avatar-initials">{initials(displayName)}</span>
		</button>
	{/snippet}
	{#snippet children()}
		<div class="avatar-menu-header">
			<span aria-hidden="true" class="avatar-initials size-10 text-base">{initials(displayName)}</span>
			<div class="min-w-0">
				<p class="truncate font-medium">{displayName}</p>
				<p class="truncate text-sm shell-muted">@{viewer.username}</p>
			</div>
		</div>
		<div class="header-menu-separator" role="separator"></div>
		<a
			role="menuitem"
			class="header-menu-item"
			href="/settings"
			aria-current={pathname === '/settings' ? 'page' : undefined}
			data-menu-activate
		>
			<svg aria-hidden="true" viewBox="0 0 20 20" class="size-4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="10" cy="6" r="3" />
				<path d="M4.2 17v-1.5a5.8 5.8 0 0 1 11.6 0V17Z" />
			</svg>
			<span>{m['hm1.account.profile']()}</span>
		</a>
		{#if viewer.role === 'admin'}
			<a role="menuitem" class="header-menu-item" href="/admin" aria-current={pathname === '/admin' || pathname.startsWith('/admin/') ? 'page' : undefined} data-menu-activate>
				<span>{m['admin.nav']()}</span>
			</a>
		{/if}
		<button type="button" role="menuitem" class="header-menu-item" onclick={onlogout} data-menu-activate>
			<svg aria-hidden="true" viewBox="0 0 20 20" class="size-4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
				<path d="M8 3H4.5A1.5 1.5 0 0 0 3 4.5v11A1.5 1.5 0 0 0 4.5 17H8" />
				<path d="M11 6l4 4-4 4m4-4H7" />
			</svg>
			<span>{m['auth.logout.submit']()}</span>
		</button>
	{/snippet}
</HeaderMenu>
