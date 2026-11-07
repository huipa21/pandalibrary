<script module lang="ts">
	import * as m from '#lib/paraglide/messages.js';

	export type BookTab = 'details' | 'files' | 'reading-log' | 'highlights';

	export const BOOK_TABS: readonly BookTab[] = ['details', 'files', 'reading-log', 'highlights'];

	export function bookTabPath(bookId: number, tab: BookTab): string {
		return tab === 'details' ? `/books/${bookId}` : `/books/${bookId}/${tab}`;
	}

	export function bookTabFromPath(pathname: string): BookTab {
		const segment = pathname.replace(/\/+$/, '').split('/')[3] ?? '';
		return (BOOK_TABS as readonly string[]).includes(segment) ? (segment as BookTab) : 'details';
	}

	export function bookTabLabel(tab: BookTab): string {
		switch (tab) {
			case 'files': return m['bv4.tabs.files']();
			case 'reading-log': return m['bv4.tabs.reading_log']();
			case 'highlights': return m['bv4.tabs.highlights']();
			default: return m['bv4.tabs.details']();
		}
	}
</script>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { browseNeighbors } from './browse-context.js';

	let { bookId, backUsesHistory = false }: { bookId: number; backUsesHistory?: boolean } = $props();

	const activeTab = $derived(bookTabFromPath(page.url.pathname));
	const neighbors = $derived(browseNeighbors(bookId));
	const backHref = $derived(neighbors?.href ?? '/books');
	let tabNav: HTMLElement | undefined = $state();

	// Keep the active tab visible when the tab strip overflows on narrow screens.
	$effect(() => {
		void activeTab;
		const current = tabNav?.querySelector<HTMLElement>('[aria-current="page"]');
		if (!tabNav || !current || tabNav.scrollWidth <= tabNav.clientWidth) return;
		const left = current.offsetLeft - tabNav.offsetLeft;
		if (left < tabNav.scrollLeft || left + current.offsetWidth > tabNav.scrollLeft + tabNav.clientWidth) {
			tabNav.scrollLeft = left - (tabNav.clientWidth - current.offsetWidth) / 2;
		}
	});

	function back(event: MouseEvent) {
		if (!backUsesHistory || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		history.back();
	}

	function openNeighbor(id: number | null) {
		if (id === null) return;
		void goto(bookTabPath(id, activeTab), { replace: true, reset: false });
	}

	function typingTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		if (target.isContentEditable) return true;
		return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
	}

	function shortcut(event: KeyboardEvent) {
		if (!neighbors || event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
		if (typingTarget(event.target)) return;
		if (event.key === '[' && neighbors.previousId !== null) {
			event.preventDefault();
			openNeighbor(neighbors.previousId);
		} else if (event.key === ']' && neighbors.nextId !== null) {
			event.preventDefault();
			openNeighbor(neighbors.nextId);
		}
	}
</script>

<svelte:window onkeydown={shortcut} />

<div class="sticky top-shell-header z-20 flex items-center gap-3 rounded-t-2xl border-b border-slate-200 bg-white px-2 sm:px-4">
	<nav bind:this={tabNav} class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label={m['bv4.tabs.label']()}>
		<a
			class="flex shrink-0 items-center gap-1 rounded-md px-2 py-3 text-sm font-medium text-slate-600 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-emerald-600"
			href={backHref}
			aria-label={m['bv4.back_label']()}
			onclick={back}
		>
			<span aria-hidden="true" class="text-lg leading-none">‹</span>
			<span>{m['bv4.back']()}</span>
		</a>
		<span class="mx-1 h-5 w-px shrink-0 bg-slate-200" aria-hidden="true"></span>
		<ul class="flex shrink-0 items-stretch gap-1">
			{#each BOOK_TABS as tab (tab)}
				{@const active = tab === activeTab}
				<li class="flex">
					<a
						class={[
							'-mb-px flex items-center whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-emerald-600',
							active ? 'border-emerald-600 text-slate-900' : 'border-transparent text-slate-600 hover:text-slate-900'
						]}
						href={bookTabPath(bookId, tab)}
						aria-current={active ? 'page' : undefined}
						data-sveltekit-replacestate
						data-sveltekit-reset="false"
					>{bookTabLabel(tab)}</a>
				</li>
			{/each}
		</ul>
	</nav>
	{#if neighbors}
		<div class="flex shrink-0 items-center gap-1" role="group" aria-label={m['bv4.browse.label']({ label: neighbors.label })}>
			<span class="px-1 text-sm tabular-nums text-slate-600" title={m['bv4.browse.position_label']({ index: neighbors.index, total: neighbors.total })}>
				{m['bv4.browse.position']({ index: neighbors.index, total: neighbors.total })}
			</span>
			<button
				type="button"
				class="flex size-8 items-center justify-center rounded-full text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
				aria-label={m['bv4.browse.previous']()}
				title={`${m['bv4.browse.previous']()} ([)`}
				aria-keyshortcuts="["
				disabled={neighbors.previousId === null}
				onclick={() => openNeighbor(neighbors.previousId)}
			>
				<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" class="size-4" aria-hidden="true"><path d="M12.5 15l-5-5 5-5" stroke-linecap="round" stroke-linejoin="round" /></svg>
			</button>
			<button
				type="button"
				class="flex size-8 items-center justify-center rounded-full text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
				aria-label={m['bv4.browse.next']()}
				title={`${m['bv4.browse.next']()} (])`}
				aria-keyshortcuts="]"
				disabled={neighbors.nextId === null}
				onclick={() => openNeighbor(neighbors.nextId)}
			>
				<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" class="size-4" aria-hidden="true"><path d="M7.5 5l5 5-5 5" stroke-linecap="round" stroke-linejoin="round" /></svg>
			</button>
		</div>
	{/if}
</div>
