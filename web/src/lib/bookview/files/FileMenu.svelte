<script lang="ts">
	import { tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '../Icon.svelte';
	import type { FileItem } from './files-model.js';

	interface Props {
		file: FileItem;
		online: boolean;
		offlineAvailable: boolean;
		busy: boolean;
		onSave: (file: FileItem) => void;
		onRemove: (file: FileItem) => void;
		onCopy: (file: FileItem) => void;
	}

	let { file, online, offlineAvailable, busy, onSave, onRemove, onCopy }: Props = $props();
	let open = $state(false);
	let root = $state<HTMLDivElement | null>(null);
	let trigger = $state<HTMLButtonElement | null>(null);
	let menu = $state<HTMLDivElement | null>(null);

	function close(restoreFocus = false) {
		open = false;
		if (restoreFocus) trigger?.focus();
	}

	async function show(last = false) {
		if (busy) return;
		open = true;
		await tick();
		const items = menu?.querySelectorAll<HTMLElement>('[role="menuitem"]');
		if (items?.length) items[last ? items.length - 1 : 0].focus();
	}

	function triggerKey(event: KeyboardEvent) {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();
		void show(event.key === 'ArrowUp');
	}

	function menuKey(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			close(true);
			return;
		}
		const items = menu?.querySelectorAll<HTMLElement>('[role="menuitem"]');
		if (!items?.length) return;
		const index = Array.from(items).findIndex((item) => item === document.activeElement);
		let next: number;
		switch (event.key) {
			case 'ArrowDown': next = (index + 1) % items.length; break;
			case 'ArrowUp': next = (index - 1 + items.length) % items.length; break;
			case 'Home': next = 0; break;
			case 'End': next = items.length - 1; break;
			default: return;
		}
		event.preventDefault();
		items[next].focus();
	}

	function outside(event: Event) {
		if (open && event.target instanceof Node && !root?.contains(event.target)) close();
	}

	function action(callback: (file: FileItem) => void) {
		close(true);
		callback(file);
	}
</script>

<svelte:document onpointerdown={outside} onfocusin={outside} />

<div bind:this={root} class="relative shrink-0">
	<button
		bind:this={trigger}
		type="button"
		class="inline-flex size-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-50"
		aria-label={m['bv7.actions_for']({ name: file.original_filename })}
		aria-haspopup="menu"
		aria-expanded={open}
		disabled={busy}
		onclick={() => open ? close() : void show()}
		onkeydown={triggerKey}
	>
		<Icon name="more" class="size-5 rotate-90" />
	</button>
	{#if open}
		<div
			bind:this={menu}
			role="menu"
			tabindex="-1"
			aria-label={m['bv7.actions_for']({ name: file.original_filename })}
			class="absolute right-0 z-30 mt-1 w-52 max-w-[calc(100vw-2rem)] rounded-lg border border-slate-200 bg-white p-1 shadow-lg"
			onkeydown={menuKey}
		>
			{#if online}
				<a
					role="menuitem"
					tabindex="-1"
					class="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-slate-800 hover:bg-slate-100 focus-visible:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-emerald-700"
					href={file.download_url}
					onclick={() => close()}
				><Icon name="download" class="size-4" />{m['catalog.book.download']()}</a>
			{/if}
			{#if offlineAvailable && (online || file.saved)}
				<button
					type="button"
					role="menuitem"
					tabindex="-1"
					class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-800 hover:bg-slate-100 focus-visible:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-emerald-700"
					onclick={() => action(file.saved ? onRemove : onSave)}
				>
					<Icon name={file.saved ? 'trash' : 'download'} class="size-4" />
					{file.saved ? m['bv7.remove_offline']() : m['bv7.save_offline']()}
				</button>
			{/if}
			<button
				type="button"
				role="menuitem"
				tabindex="-1"
				class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-800 hover:bg-slate-100 focus-visible:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-emerald-700"
				onclick={() => action(onCopy)}
			><Icon name="copy" class="size-4" />{m['bv7.copy_name']()}</button>
		</div>
	{/if}
</div>
