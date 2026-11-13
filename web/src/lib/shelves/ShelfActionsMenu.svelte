<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { page } from '$app/state';
	import { deLocalizeHref } from '#lib/paraglide/runtime.js';
	import HeaderMenu from '#lib/shell/HeaderMenu.svelte';
	import ShelfCreateDialog from './ShelfCreateDialog.svelte';
	import type { Shelf } from './types.js';

	let { pathname, role, currentShelf }: { pathname: string; role: string; currentShelf?: Shelf } = $props();
	let dialogOpen = $state(false);
	const isCollection = $derived(/^\/shelves\/[1-9]\d*\/?$/.test(deLocalizeHref(pathname)));
	const isSystemCollection = $derived(/^\/shelves\/system\/(?:favorites|unshelved)\/?$/.test(deLocalizeHref(pathname)));
	const manageHref = $derived.by(() => {
		const params = new URLSearchParams(page.url.searchParams.toString());
		params.set('manage', '1');
		return `${page.url.pathname}?${params}`;
	});

	async function openCreate(close: () => Promise<void>) {
		await close();
		dialogOpen = true;
	}
</script>

<HeaderMenu menuId="sidebar-shelves-menu" popup="menu" label={m['ux1.shelves.actions']()} panelClass="shelf-actions-menu">
	{#snippet trigger({ expanded, controls, popup, toggle, onkeydown })}
		<button
			type="button"
			class="shell-icon-button"
			aria-label={m['ux1.shelves.actions']()}
			title={m['ux1.shelves.actions']()}
			aria-haspopup={popup}
			aria-expanded={expanded}
			aria-controls={controls}
			onclick={toggle}
			onkeydown={onkeydown}
		>
			<svg aria-hidden="true" viewBox="0 0 20 20" class="size-4" fill="currentColor">
				<circle cx="10" cy="4" r="1.6" />
				<circle cx="10" cy="10" r="1.6" />
				<circle cx="10" cy="16" r="1.6" />
			</svg>
		</button>
	{/snippet}
	{#snippet children(close)}
		<button type="button" role="menuitem" tabindex="-1" class="header-menu-item" onclick={() => void openCreate(close)}>
			{m['ux1.shelves.create']()}
		</button>
		{#if isCollection || isSystemCollection}
			<a role="menuitem" tabindex="-1" class="header-menu-item" href={manageHref} data-menu-activate>
				{currentShelf && (role === 'admin' || currentShelf.kind === 'private') ? m['collections.manage']() : m['shelves.details']()}
			</a>
		{/if}
		<a
			role="menuitem"
			tabindex="-1"
			class="header-menu-item"
			href="/shelves"
			aria-current={deLocalizeHref(pathname).replace(/\/+$/, '') === '/shelves' ? 'page' : undefined}
			data-menu-activate
		>
			{m['ux1.shelves.more']()}
		</a>
	{/snippet}
</HeaderMenu>

<ShelfCreateDialog open={dialogOpen} allowShared={role === 'admin'} onclose={() => { dialogOpen = false; }} />
