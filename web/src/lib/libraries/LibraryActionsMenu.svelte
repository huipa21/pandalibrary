<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import HeaderMenu from '#lib/shell/HeaderMenu.svelte';
	import Icon from '#lib/bookview/Icon.svelte';

	let { role, libraryID }: { role: string; libraryID?: number } = $props();
</script>

<HeaderMenu menuId="sidebar-library-menu" popup="menu" label={m['ux1.library.actions']()} panelClass="shelf-actions-menu">
	{#snippet trigger({ expanded, controls, popup, toggle, onkeydown })}
		<button type="button" class="shell-icon-button" aria-label={m['ux1.library.actions']()} title={m['ux1.library.actions']()} aria-haspopup={popup} aria-expanded={expanded} aria-controls={controls} onclick={toggle} onkeydown={onkeydown}>
			<svg aria-hidden="true" viewBox="0 0 20 20" class="size-4" fill="currentColor">
				<circle cx="10" cy="4" r="1.6" /><circle cx="10" cy="10" r="1.6" /><circle cx="10" cy="16" r="1.6" />
			</svg>
		</button>
	{/snippet}
	{#snippet children()}
		{#if role === 'admin'}
			<a role="menuitem" tabindex="-1" class="header-menu-item" href="/admin/libraries?create=1" data-menu-activate><Icon name="plus" class="size-4 shrink-0" />{m['ux1.library.new']()}</a>
			{#if libraryID !== undefined}
				<a role="menuitem" tabindex="-1" class="header-menu-item" href={`/admin/libraries?edit=${libraryID}`} data-menu-activate><Icon name="pencil" class="size-4 shrink-0" />{m['ux1.library.edit']()}</a>
			{/if}
		{/if}
		<a role="menuitem" tabindex="-1" class="header-menu-item" href={role === 'admin' ? '/admin/libraries' : '/libraries'} data-menu-activate><Icon name="list-tree" class="size-4 shrink-0" />{m['ux1.library.manage']()}</a>
	{/snippet}
</HeaderMenu>
