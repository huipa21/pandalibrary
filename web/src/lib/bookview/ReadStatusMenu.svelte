<script lang="ts">
	import { tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import Icon from './Icon.svelte';
	import StatusIcon from './StatusIcon.svelte';
	import {
		availableReadStatuses, previewUserBook, readStatusLabel, saveUserBook, statusPatch, statusTone, type ReadStatus, type UserBook
	} from './user-book.js';

	interface Props {
		bookId: number;
		userBook: UserBook | null;
		percentage?: number | null;
		variant?: 'pill' | 'icon' | 'badge' | 'inline';
		loadCurrentUserBook?: (bookId: number) => Promise<UserBook | null>;
	}

	let { bookId, userBook, percentage = 0, variant = 'pill', loadCurrentUserBook }: Props = $props();
	const menuId = $props.id();
	let optimistic = $state<UserBook | undefined>(undefined);
	let open = $state(false);
	let busy = $state(false);
	let error = $state('');
	let root = $state<HTMLDivElement | null>(null);
	let trigger = $state<HTMLButtonElement | null>(null);
	let menu = $state<HTMLDivElement | null>(null);
	let menuPosition = $state<{ left: number; top: number } | null>(null);
	const positioned = $derived(variant === 'badge' || variant === 'inline');
	let propVersion = 0;
	const current = $derived(optimistic ?? userBook);
	const selected = $derived(current?.status ?? 'unread');
	const statuses = $derived(availableReadStatuses(current, percentage ?? 0));

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

	$effect(() => {
		if (!open || !positioned) return;
		window.addEventListener('resize', positionMenu);
		window.addEventListener('scroll', positionMenu, true);
		return () => {
			window.removeEventListener('resize', positionMenu);
			window.removeEventListener('scroll', positionMenu, true);
		};
	});

	function positionMenu() {
		if (!root || !trigger || !menu) return;
		const triggerBox = trigger.getBoundingClientRect();
		const menuBox = menu.getBoundingClientRect();
		const padding = 8;
		const gap = 8;
		const width = document.documentElement.clientWidth;
		const height = window.innerHeight;
		const below = height - triggerBox.bottom - gap - padding;
		const above = triggerBox.top - gap - padding;
		const opensUp = menuBox.height > below && above > below;
		const desiredTop = opensUp ? triggerBox.top - gap - menuBox.height : triggerBox.bottom + gap;
		const left = Math.max(padding, Math.min(triggerBox.left, width - padding - menuBox.width));
		const top = Math.max(padding, Math.min(desiredTop, height - padding - menuBox.height));
		menuPosition = { left, top };
	}

	async function openMenu(position: 'first' | 'last' | 'current' = 'current') {
		if (busy) return;
		menuPosition = null;
		open = true;
		await tick();
		if (!open) return;
		if (variant === 'badge') {
			if (!menu) return;
			try {
				if (typeof menu.showPopover === 'function') {
					menu.showPopover();
				} else {
					menu.removeAttribute('popover');
					document.body.appendChild(menu);
				}
			} catch (cause) {
				console.error('Could not open the reading status menu', cause);
				closeMenu(true);
				error = m['bc4.menu_failed']();
				return;
			}
		}
		if (positioned) {
			positionMenu();
			await tick();
			if (!open) return;
		}
		const options = menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
		if (!options?.length) return;
		const index = position === 'first' ? 0 : position === 'last' ? options.length - 1 : statuses.indexOf(selected);
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

	function toggleMenu(event: MouseEvent) {
		event.stopPropagation();
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
		if (open && event.target instanceof Node && !root?.contains(event.target) && !menu?.contains(event.target)) {
			closeMenu();
		}
	}

	async function select(status: ReadStatus) {
		if (busy) return;
		const before = optimistic;
		const displayed = current;
		closeMenu(true);
		const version = propVersion;
		const targetBookId = bookId;
		error = '';
		busy = true;
		try {
			const previewPatch = statusPatch(displayed, status);
			if (!loadCurrentUserBook && (displayed?.status ?? 'unread') === status && Object.keys(previewPatch).length === 1) return;
			optimistic = previewUserBook(displayed, previewPatch);
			const previous = loadCurrentUserBook ? await loadCurrentUserBook(targetBookId) : displayed;
			if (targetBookId !== bookId) return;
			if (version !== propVersion) {
				error = m['bv3.status_failed']();
				return;
			}
			const patch = statusPatch(previous, status);
			optimistic = previewUserBook(previous, patch);
			if ((previous?.status ?? 'unread') === status && Object.keys(patch).length === 1) return;
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
		class={variant === 'badge'
			? 'inline-flex size-7 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-black/5 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-700 aria-disabled:opacity-60'
			: variant === 'icon'
				? 'inline-flex size-10 items-center justify-center rounded-full border border-slate-300 text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-700 aria-disabled:opacity-60'
				: variant === 'inline'
					? 'inline-flex items-center gap-1.5 rounded-md bg-transparent px-2 py-1 text-sm font-medium text-slate-800 hover:bg-slate-900/5 focus-visible:outline-2 focus-visible:outline-emerald-700 aria-disabled:opacity-60'
				: 'inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-700 aria-disabled:opacity-60'}
		aria-label={variant === 'badge'
			? m['bc1.status_badge']({ status: readStatusLabel(selected) })
			: variant === 'icon' ? m['bv3.status_menu']() : m['bv3.status_menu_current']({ status: readStatusLabel(selected) })}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-controls={open ? menuId : undefined}
		aria-busy={busy}
		aria-disabled={busy}
		title={m['bv3.status_menu_current']({ status: readStatusLabel(selected) })}
		onclick={toggleMenu}
		onkeydown={triggerKey}
	>
		<StatusIcon status={selected} class={`${variant === 'inline' ? 'size-4' : 'size-5'} shrink-0 ${statusTone(selected).text}`} />
		{#if variant === 'pill'}<span>{readStatusLabel(selected)}</span><Icon name="chevron-down" class="size-4" />{/if}
		{#if variant === 'inline'}
			<span>{readStatusLabel(selected)}</span>
			<Icon name="chevron-down" class={`size-4 text-slate-500 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
		{/if}
	</button>
	{#if open}
		<div
			bind:this={menu}
			id={menuId}
			role="menu"
			tabindex="-1"
			aria-label={m['bv3.status_menu']()}
			popover={variant === 'badge' ? 'manual' : undefined}
			class="absolute top-full z-30 mt-2 max-h-[calc(100dvh-1rem)] w-48 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg"
			style={positioned
				? menuPosition
					? `position: fixed; inset: auto; left: ${menuPosition.left}px; top: ${menuPosition.top}px; margin: 0; z-index: 100`
					: 'position: fixed; inset: auto; left: 0; top: 0; margin: 0; z-index: 100; visibility: hidden'
				: undefined}
			onkeydown={menuKey}
		>
			{#each statuses as status}
				<button
					type="button"
					role="menuitemradio"
					aria-checked={status === selected}
					tabindex="-1"
					class="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-slate-800 hover:bg-slate-100 focus:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-700"
					onclick={(event) => { event.stopPropagation(); void select(status); }}
				>
					<StatusIcon {status} class={`size-5 shrink-0 ${statusTone(status).text}`} />
					<span class="flex-1 whitespace-nowrap">{readStatusLabel(status)}</span>
					{#if status === selected}
						<svg aria-hidden="true" class="size-4 shrink-0 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="m5 12 4 4L19 6" />
						</svg>
					{/if}
				</button>
			{/each}
		</div>
	{/if}
	{#if error}<p class="mt-2 text-sm text-red-800" role="alert">{error}</p>{/if}
</div>
