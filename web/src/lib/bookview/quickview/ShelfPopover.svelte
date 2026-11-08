<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { translate } from '#lib/paging/translate.js';
	import { addBookToShelf } from '#lib/shelves/api.js';
	import { loadAddableShelves } from '#lib/shelves/addable.js';
	import { shelfErrorKey } from '#lib/shelves/form.js';
	import type { Shelf } from '#lib/shelves/types.js';
	import Icon from '../Icon.svelte';

	let { bookId, memberIds = [], variant = 'icon', placement = 'up' }: {
		bookId: number;
		memberIds?: readonly number[];
		variant?: 'icon' | 'button';
		placement?: 'up' | 'down';
	} = $props();
	const panelId = $props.id();
	let open = $state(false);
	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let shelves = $state<Shelf[]>([]);
	let loadError = $state('');
	let busy = $state<number | null>(null);
	let notice = $state('');
	let error = $state('');
	let root = $state<HTMLDivElement | null>(null);
	let trigger = $state<HTMLButtonElement | null>(null);
	let panel = $state<HTMLDivElement | null>(null);
	let panelOffset = $state(0);
	let panelMaxHeight = $state<number | undefined>(undefined);
	let controller: AbortController | null = null;

	onDestroy(() => controller?.abort());

	// Deriveds only notify on value changes, so refreshing the parent's book object keeps the notice.
	const currentBookId = $derived(bookId);

	$effect(() => {
		currentBookId;
		open = false;
		notice = '';
		error = '';
	});

	function options(): HTMLButtonElement[] {
		return [...(panel?.querySelectorAll<HTMLButtonElement>('[data-shelf-option]') ?? [])];
	}

	async function load() {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		status = 'loading';
		loadError = '';
		try {
			const addable = await loadAddableShelves(current.signal);
			if (current.signal.aborted) return;
			shelves = addable;
			status = 'ready';
		} catch (cause) {
			if (current.signal.aborted) return;
			loadError = translate(shelfErrorKey(cause, 'load'));
			status = 'error';
		}
		await tick();
		if (open && !panel?.contains(document.activeElement)) (options()[0] ?? panel)?.focus();
	}

	async function show() {
		open = true;
		notice = '';
		error = '';
		await tick();
		clampPanel();
		panel?.focus();
		void load();
	}

	function clampPanel() {
		if (!open || placement !== 'down' || !panel) return;
		const bounds = panel.getBoundingClientRect();
		const left = bounds.left - panelOffset;
		panelOffset = Math.max(16 - left, Math.min(0, window.innerWidth - 16 - left - bounds.width));
		panelMaxHeight = Math.max(0, window.innerHeight - 16 - bounds.top);
	}

	function hide(restoreFocus = false) {
		open = false;
		controller?.abort();
		if (restoreFocus) trigger?.focus();
	}

	async function add(shelf: Shelf) {
		if (busy !== null || memberIds.includes(shelf.id)) return;
		const targetBook = bookId;
		busy = shelf.id;
		notice = '';
		error = '';
		try {
			await addBookToShelf(shelf.id, targetBook);
			if (targetBook !== bookId) return;
			notice = m['shelves.book.added']({ name: shelf.name });
			hide(true);
			window.dispatchEvent(new CustomEvent('pandalibrary-shelves-changed'));
		} catch (cause) {
			if (targetBook === bookId) error = translate(shelfErrorKey(cause, 'add_book'));
		} finally {
			busy = null;
		}
	}

	function keydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			hide(true);
			return;
		}
		const items = options();
		if (!items.length) return;
		const index = items.findIndex((item) => item === document.activeElement);
		let next: number;
		switch (event.key) {
			case 'ArrowDown': next = (index + 1) % items.length; break;
			case 'ArrowUp': next = (index - 1 + items.length) % items.length; break;
			case 'Home': next = 0; break;
			case 'End': next = items.length - 1; break;
			default: return;
		}
		event.preventDefault();
		items[next]?.focus();
	}

	function outside(event: Event) {
		if (open && event.target instanceof Node && !root?.contains(event.target)) hide();
	}
</script>

<svelte:document onpointerdown={outside} onfocusin={outside} />
<svelte:window onresize={clampPanel} />

<div bind:this={root} class="relative inline-block">
	<button
		bind:this={trigger}
		type="button"
		class={variant === 'button'
			? 'inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-700'
			: 'inline-flex size-10 items-center justify-center rounded-full border border-slate-300 text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-700'}
		aria-label={m['bv5.add_to_shelf']()}
		title={m['bv5.add_to_shelf']()}
		aria-haspopup="dialog"
		aria-expanded={open}
		aria-controls={open ? panelId : undefined}
		onclick={() => (open ? hide() : void show())}
	><Icon name="folder-plus" />{#if variant === 'button'}{m['shelves.book.add']()}{/if}</button>
	{#if open}
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div
			bind:this={panel}
			id={panelId}
			role="dialog"
			aria-label={m['bv5.add_to_shelf']()}
			tabindex="-1"
			class={`absolute z-20 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white p-2 text-left shadow-lg focus:outline-none ${placement === 'down' ? 'top-full left-0 mt-2 overflow-y-auto' : 'right-0 bottom-full mb-2'}`}
			style:margin-left={placement === 'down' ? `${panelOffset}px` : undefined}
			style:max-height={placement === 'down' && panelMaxHeight !== undefined ? `${panelMaxHeight}px` : undefined}
			onkeydown={keydown}
		>
			<p class="px-2 pt-1 pb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">{m['bv5.add_to_shelf']()}</p>
			{#if status === 'loading'}
				<p class="px-2 py-2 text-sm text-slate-600" role="status">{m['shelves.book.loading']()}</p>
			{:else if status === 'error'}
				<div class="space-y-2 px-2 py-2 text-sm text-red-800" role="alert">
					<p>{loadError}</p>
					<button type="button" class="rounded underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-emerald-700" onclick={() => void load()}>{m['shelves.retry']()}</button>
				</div>
			{:else if shelves.length === 0}
				<p class="px-2 py-2 text-sm text-slate-600">
					{m['shelves.book.none']()}
					<a class="ml-1 rounded underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-emerald-700" href="/shelves">{m['shelves.book.create_link']()}</a>
				</p>
			{:else}
				<ul class="max-h-64 overflow-y-auto">
					{#each shelves as shelf (shelf.id)}
						{@const member = memberIds.includes(shelf.id)}
						<li>
							<button
								type="button"
								data-shelf-option
								class="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-sm text-slate-800 hover:bg-slate-100 focus-visible:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-emerald-700 aria-disabled:text-slate-500"
								aria-disabled={member || busy !== null}
								aria-busy={busy === shelf.id}
								onclick={() => void add(shelf)}
							>
								<span class="min-w-0 truncate">{shelf.name}</span>
								<span class="shrink-0 text-xs text-slate-500">
									{#if member}<span aria-hidden="true">✓</span><span class="sr-only">{m['bv5.shelf_member']()}</span>
									{:else if busy === shelf.id}{m['shelves.book.adding']()}
									{:else}{shelf.kind === 'shared' ? m['shelves.kind.shared']() : m['shelves.kind.private']()}{/if}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
			{#if error}<p class="px-2 py-2 text-sm text-red-800" role="alert">{error}</p>{/if}
		</div>
	{/if}
	{#if notice}<p class="sr-only" role="status">{notice}</p>{/if}
</div>
