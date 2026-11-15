<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import HeaderMenu from '#lib/shell/HeaderMenu.svelte';
	import Icon from '#lib/bookview/Icon.svelte';
	import LibraryCreateDialog from './LibraryCreateDialog.svelte';

	let { role }: { role: string } = $props();
	let dialogOpen = $state(false);

	async function openCreate(close: () => Promise<void>) {
		await close();
		dialogOpen = true;
	}
</script>

<HeaderMenu menuId="sidebar-library-menu" popup="menu" label={m['ux1.library.actions']()} panelClass="shelf-actions-menu">
	{#snippet trigger({ expanded, controls, popup, toggle, onkeydown })}
		<button type="button" class="shell-icon-button" aria-label={m['ux1.library.actions']()} title={m['ux1.library.actions']()} aria-haspopup={popup} aria-expanded={expanded} aria-controls={controls} onclick={toggle} onkeydown={onkeydown}>
			<svg aria-hidden="true" viewBox="0 0 20 20" class="size-4" fill="currentColor">
				<circle cx="10" cy="4" r="1.6" /><circle cx="10" cy="10" r="1.6" /><circle cx="10" cy="16" r="1.6" />
			</svg>
		</button>
	{/snippet}
	{#snippet children(close)}
		{#if role === 'admin'}
			<button type="button" role="menuitem" tabindex="-1" class="header-menu-item" onclick={() => void openCreate(close)}><Icon name="plus" class="size-4 shrink-0" />{m['ux1.library.new']()}</button>
		{/if}
		<a role="menuitem" tabindex="-1" class="header-menu-item" href="/libraries" data-menu-activate><Icon name="list-tree" class="size-4 shrink-0" />{m['ux1.library.manage']()}</a>
	{/snippet}
</HeaderMenu>

{#if role === 'admin'}
	<LibraryCreateDialog open={dialogOpen} onclose={() => { dialogOpen = false; }} />
{/if}
