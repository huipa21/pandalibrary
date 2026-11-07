<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { Book } from '#lib/catalog/types.js';
	import { focusableWithin, nextTrappedFocus } from '#lib/shell/focus.js';
	import { BOOK_STATE_CHANGED_EVENT, type BookStateChangedDetail } from '../events.js';
	import Icon from '../Icon.svelte';
	import { loadQuickView, QuickViewNotFoundError, type QuickViewData } from './quick-view-data.js';
	import QuickViewContent from './QuickViewContent.svelte';

	interface Props {
		bookId: number;
		seed?: Book;
		admin?: boolean;
		onclose: () => void;
	}

	let { bookId, seed, admin = false, onclose }: Props = $props();
	const titleId = $props.id();
	let status = $state<'loading' | 'ready' | 'not-found' | 'error'>('loading');
	let data = $state.raw<QuickViewData | null>(null);
	let panel = $state<HTMLDivElement | null>(null);
	let closeButton = $state<HTMLButtonElement | null>(null);
	let controller: AbortController | null = null;

	async function load(silent: boolean) {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		const id = bookId;
		const seeded = seed;
		if (!silent || !data || data.book.id !== id) {
			status = 'loading';
			data = null;
		}
		try {
			const result = await loadQuickView(id, seeded, current.signal);
			if (current !== controller) return;
			data = result;
			status = 'ready';
		} catch (cause) {
			if (current !== controller || current.signal.aborted) return;
			if (silent && data?.book.id === id) {
				console.warn('Could not refresh the quick view', cause);
				return;
			}
			if (!(cause instanceof QuickViewNotFoundError)) console.error('Could not load the quick view', cause);
			data = null;
			status = cause instanceof QuickViewNotFoundError ? 'not-found' : 'error';
		}
	}

	$effect(() => {
		bookId;
		seed;
		untrack(() => void load(false));
	});

	function stateChanged(event: Event) {
		const detail = (event as CustomEvent<BookStateChangedDetail>).detail;
		if (detail?.bookId === bookId) void load(true);
	}

	function shelvesChanged() {
		void load(true);
	}

	onMount(() => {
		const body = document.body;
		const overflow = body.style.overflow;
		body.style.overflow = 'hidden';
		closeButton?.focus();
		window.addEventListener(BOOK_STATE_CHANGED_EVENT, stateChanged);
		window.addEventListener('pandalibrary-shelves-changed', shelvesChanged);
		return () => {
			body.style.overflow = overflow;
			window.removeEventListener(BOOK_STATE_CHANGED_EVENT, stateChanged);
			window.removeEventListener('pandalibrary-shelves-changed', shelvesChanged);
		};
	});

	onDestroy(() => {
		controller?.abort();
		controller = null;
	});

	function keydown(event: KeyboardEvent) {
		if (event.defaultPrevented) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			onclose();
			return;
		}
		if (event.key !== 'Tab') return;
		const target = nextTrappedFocus(focusableWithin(panel), document.activeElement, event.shiftKey);
		if (target) {
			event.preventDefault();
			target.focus();
		}
	}
</script>

<svelte:window onkeydown={keydown} />

<div class="fixed inset-0 z-[70]" data-quick-view>
	<div class="quick-view-backdrop absolute inset-0 bg-slate-900/40" aria-hidden="true" data-quick-view-backdrop onclick={onclose}></div>
	<div
		bind:this={panel}
		class="quick-view-panel absolute inset-y-0 right-0 flex w-full flex-col border-l border-slate-200 bg-white text-slate-950 shadow-2xl sm:w-[28rem]"
		role="dialog"
		aria-modal="true"
		aria-labelledby={titleId}
	>
		<div class="flex shrink-0 items-center justify-between gap-2 px-3 pt-3 pb-2">
			<div class="min-w-0">
				{#if admin && data && !data.offline}
					<a
						class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-emerald-700"
						href={`/books/${data.book.id}/edit`}
					><Icon name="pencil" class="size-3.5" />{m['bv5.edit_metadata']()}</a>
				{/if}
			</div>
			<button
				bind:this={closeButton}
				type="button"
				class="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-emerald-700"
				aria-label={m['bv5.close']()}
				title={m['bv5.close']()}
				onclick={onclose}
			><Icon name="x" /></button>
		</div>

		{#if status === 'ready' && data}
			<QuickViewContent {data} {titleId} />
		{:else if status === 'loading'}
			<div class="flex-1 space-y-4 px-5" role="status" aria-live="polite">
				<h2 id={titleId} class="sr-only">{m['bv5.dialog_label']()}</h2>
				<div class="flex gap-4" aria-hidden="true">
					<div class="aspect-book w-24 animate-pulse rounded-lg bg-slate-100 motion-reduce:animate-none"></div>
					<div class="flex-1 space-y-2 pt-1">
						<div class="h-5 w-3/4 animate-pulse rounded bg-slate-100 motion-reduce:animate-none"></div>
						<div class="h-4 w-1/2 animate-pulse rounded bg-slate-100 motion-reduce:animate-none"></div>
					</div>
				</div>
				<p class="text-sm text-slate-600">{m['bv5.loading']()}</p>
			</div>
		{:else}
			<div class="flex-1 space-y-3 px-5" role="alert">
				<h2 id={titleId} class="text-lg font-semibold">
					{status === 'not-found' ? m['bv5.not_found_title']() : m['bv5.error_title']()}
				</h2>
				<p class="text-sm text-slate-600">{status === 'not-found' ? m['bv5.not_found']() : m['bv5.error']()}</p>
				{#if status === 'error'}
					<button
						type="button"
						class="rounded-full border border-emerald-700 px-4 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
						onclick={() => void load(false)}
					>{m['bv5.retry']()}</button>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.quick-view-panel {
		animation: quick-view-in 200ms ease-out;
	}

	.quick-view-backdrop {
		animation: quick-view-fade 200ms ease-out;
	}

	@keyframes quick-view-in {
		from { transform: translateX(100%); }
		to { transform: translateX(0); }
	}

	@keyframes quick-view-fade {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	@media (prefers-reduced-motion: reduce) {
		.quick-view-panel,
		.quick-view-backdrop {
			animation: none;
		}
	}
</style>
