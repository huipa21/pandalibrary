<script lang="ts">
	import { tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import Icon from './Icon.svelte';
	import {
		previewUserBook, READ_STATUSES, readStatusLabel, saveUserBook, statusPatch, type ReadStatus, type UserBook
	} from './user-book.js';

	interface Props {
		bookId: number;
		userBook: UserBook | null;
		reread?: boolean;
		variant?: 'pill' | 'icon';
	}

	let { bookId, userBook, reread = false, variant = 'pill' }: Props = $props();
	let optimistic = $state<UserBook | undefined>(undefined);
	let open = $state(false);
	let busy = $state(false);
	let error = $state('');
	let root = $state<HTMLDivElement | null>(null);
	let trigger = $state<HTMLButtonElement | null>(null);
	let menu = $state<HTMLDivElement | null>(null);
	let propVersion = 0;
	const current = $derived(optimistic ?? userBook);
	const selected = $derived(current?.status ?? 'unread');

	$effect(() => {
		bookId;
		userBook?.status;
		userBook?.rating;
		userBook?.started_at;
		userBook?.finished_at;
		userBook?.updated_at;
		userBook?.rev;
		propVersion += 1;
		optimistic = undefined;
		error = '';
		open = false;
	});

	function label(status: ReadStatus): string {
		return readStatusLabel(status, reread);
	}

	async function openMenu(position: 'first' | 'last' | 'current' = 'current') {
		if (busy) return;
		open = true;
		await tick();
		const options = menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
		if (!options?.length) return;
		const index = position === 'first' ? 0 : position === 'last' ? options.length - 1 : READ_STATUSES.indexOf(selected);
		options[index]?.focus();
	}

	function closeMenu(restoreFocus = false) {
		open = false;
		if (restoreFocus) trigger?.focus();
	}

	function triggerKey(event: KeyboardEvent) {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();
		void openMenu(event.key === 'ArrowDown' ? 'first' : 'last');
	}

	function toggleMenu() {
		if (busy) return;
		if (open) closeMenu();
		else void openMenu();
	}

	function menuKey(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closeMenu(true);
			return;
		}
		const options = menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
		if (!options?.length) return;
		const index = Array.from(options).findIndex((option) => option === document.activeElement);
		let next: number;
		switch (event.key) {
			case 'ArrowDown': next = (index + 1) % options.length; break;
			case 'ArrowUp': next = (index - 1 + options.length) % options.length; break;
			case 'Home': next = 0; break;
			case 'End': next = options.length - 1; break;
			default: return;
		}
		event.preventDefault();
		options[next]?.focus();
	}

	function outside(event: Event) {
		if (open && event.target instanceof Node && !root?.contains(event.target)) closeMenu();
	}

	async function select(status: ReadStatus) {
		if (busy) return;
		const before = optimistic;
		const previous = current;
		const patch = statusPatch(previous, status);
		closeMenu(true);
		if (previous?.status === status && Object.keys(patch).length === 1) return;
		const version = propVersion;
		const targetBookId = bookId;
		optimistic = previewUserBook(previous, patch);
		error = '';
		busy = true;
		try {
			await saveUserBook(targetBookId, previous, patch);
		} catch (cause) {
			console.error('Could not update reading status', cause);
			if (version === propVersion && targetBookId === bookId) {
				optimistic = before;
				error = m['bv3.status_failed']();
			}
		} finally {
			busy = false;
		}
	}
</script>

<svelte:document onpointerdown={outside} onfocusin={outside} />

<div bind:this={root} class="relative inline-block text-left">
	<button
		bind:this={trigger}
		type="button"
		class={variant === 'icon'
			? 'inline-flex size-10 items-center justify-center rounded-full border border-slate-300 text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-700 aria-disabled:opacity-60'
			: 'inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-700 aria-disabled:opacity-60'}
		aria-label={variant === 'icon' ? m['bv3.status_menu']() : m['bv3.status_menu_current']({ status: label(selected) })}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-busy={busy}
		aria-disabled={busy}
		title={m['bv3.status_menu_current']({ status: label(selected) })}
		onclick={toggleMenu}
		onkeydown={triggerKey}
	>
		<Icon name="eye" />
		{#if variant === 'pill'}<span>{label(selected)}</span><Icon name="chevron-down" class="size-4" />{/if}
	</button>
	{#if open}
		<div
			bind:this={menu}
			role="menu"
			tabindex="-1"
			aria-label={m['bv3.status_menu']()}
			class="absolute z-20 mt-2 min-w-44 rounded-lg border border-slate-200 bg-white p-1 shadow-lg"
			onkeydown={menuKey}
		>
			{#each READ_STATUSES as status}
				<button
					type="button"
					role="menuitemradio"
					aria-checked={status === selected}
					tabindex="-1"
					class="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm text-slate-800 hover:bg-slate-100 focus-visible:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-emerald-700"
					onclick={() => void select(status)}
				>
					<span>{label(status)}</span>
					{#if status === selected}<span aria-hidden="true">✓</span>{/if}
				</button>
			{/each}
		</div>
	{/if}
	{#if error}<p class="mt-2 text-sm text-red-800" role="alert">{error}</p>{/if}
</div>
