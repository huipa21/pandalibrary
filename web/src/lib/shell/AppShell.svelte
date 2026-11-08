<script lang="ts">
	import { onMount, tick, type Snippet } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import * as m from '#lib/paraglide/messages.js';
	import type { Locale } from '#lib/paraglide/runtime.js';
	import { isImmersiveRoute } from '#lib/nav.js';
	import SearchBox from '#lib/search/SearchBox.svelte';
	import UploadButton from '#lib/bookheap/UploadButton.svelte';
	import QuickViewHost from '#lib/bookview/quickview/QuickViewHost.svelte';
	import AvatarMenu from './AvatarMenu.svelte';
	import LanguageMenu from './LanguageMenu.svelte';
	import Sidebar from './Sidebar.svelte';
	import ThemeToggle from './ThemeToggle.svelte';
	import { focusableWithin, nextTrappedFocus } from './focus.js';

	interface Props {
		pathname: string;
		viewer: { username: string; display_name: string; role: string } | null;
		onlogout: () => void;
		onlocale: (locale: Locale) => void | Promise<void>;
		children: Snippet;
		/** Sidebar SHELVES slot; see `Sidebar.svelte`. */
		shelves?: Snippet;
		/** Sidebar footer slot reserved for the build version. */
		footer?: Snippet;
	}

	let { pathname, viewer, onlogout, onlocale, children, shelves, footer }: Props = $props();

	const SIDEBAR_ID = 'app-sidebar';
	let open = $state(false);
	let desktop = $state(false);
	let toggle = $state<HTMLButtonElement | null>(null);
	let drawer = $state<HTMLElement | null>(null);
	const immersive = $derived(isImmersiveRoute(pathname));
	/** True while the sidebar floats above the page as a modal drawer rather than a fixed column. */
	const overlay = $derived(open && (immersive || !desktop));

	onMount(() => {
		const query = window.matchMedia('(min-width: 64rem)');
		const update = () => {
			desktop = query.matches;
			if (desktop && !immersive) open = false;
		};
		update();
		query.addEventListener('change', update);
		return () => query.removeEventListener('change', update);
	});

	afterNavigate(() => {
		open = false;
	});

	async function openDrawer() {
		open = true;
		await tick();
		const [first] = focusableWithin(drawer);
		first?.focus();
	}

	function closeDrawer(returnFocus = true) {
		open = false;
		if (returnFocus) toggle?.focus();
	}

	function onkeydown(event: KeyboardEvent) {
		if (!overlay) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			closeDrawer();
			return;
		}
		if (event.key === 'Tab') {
			const target = nextTrappedFocus(
				[...(toggle ? [toggle] : []), ...focusableWithin(drawer)],
				document.activeElement,
				event.shiftKey
			);
			if (target) {
				event.preventDefault();
				target.focus();
			}
		}
	}
</script>

<svelte:window {onkeydown} />

<div class="app-shell flex min-h-dvh flex-col">
	<a
		class="sr-only z-[60] rounded-md bg-emerald-700 px-3 py-2 text-white focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
		href="#main-content"
	>{m['ux1.skip_to_content']()}</a>
	<div class="shell-header-band shrink-0">
		<header class="shell-header flex h-shell-header items-center gap-1 rounded-2xl border px-3 shadow-sm sm:gap-3 sm:px-4">
			{#if viewer}
				<button
					bind:this={toggle}
					class={`shell-icon-button size-9 ${immersive ? '' : 'lg:hidden'}`}
					aria-controls={SIDEBAR_ID}
					aria-expanded={open}
					aria-label={open ? m['ux1.menu.close']() : m['ux1.menu.open']()}
					title={open ? m['ux1.menu.close']() : m['ux1.menu.open']()}
					onclick={() => (open ? closeDrawer() : openDrawer())}
				>
					<svg aria-hidden="true" viewBox="0 0 20 20" class="size-5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round">
						{#if open}<path d="M5 5l10 10M15 5L5 15" />{:else}<path d="M3 5h14M3 10h14M3 15h14" />{/if}
					</svg>
				</button>
			{/if}
			<a class="shell-control flex shrink-0 items-center gap-2 font-semibold" href="/">
				<span aria-hidden="true" class="grid size-7 place-items-center rounded-md bg-emerald-500/20 text-sm text-emerald-300">P</span>
				<span class={viewer ? 'hidden sm:inline' : ''}>{m['common.app_name']()}</span>
				{#if viewer}<span class="sr-only sm:hidden">{m['common.app_name']()}</span>{/if}
			</a>
			<div class="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
				{#if viewer && pathname !== '/search'}
					<div class="shell-search min-w-0">
						<SearchBox />
					</div>
				{/if}
				{#if viewer?.role === 'admin' && !immersive}
					<UploadButton />
				{/if}
				{#if viewer}
					<div class="hidden sm:block"><LanguageMenu {onlocale} /></div>
					<div class="hidden sm:block"><ThemeToggle /></div>
					<AvatarMenu {pathname} {viewer} {onlogout} />
				{:else}
					<LanguageMenu {onlocale} />
					<ThemeToggle />
				{/if}
			</div>
		</header>
	</div>

	<div class="shell-body flex min-h-0 flex-1">
		{#if viewer}
			{#if overlay}
				<button
					class="shell-backdrop fixed inset-x-0 bottom-0 z-30 cursor-default bg-black/60"
					aria-hidden="true"
					tabindex="-1"
					onclick={() => closeDrawer()}
				></button>
			{/if}
			<aside
				bind:this={drawer}
				id={SIDEBAR_ID}
				aria-label={m['ux1.sidebar.label']()}
				aria-modal={overlay ? 'true' : undefined}
				role={overlay ? 'dialog' : undefined}
				class={[
					'shell-sidebar z-40 w-shell-sidebar shrink-0 flex-col rounded-2xl border',
					'fixed max-w-[85vw] shadow-2xl',
					open ? 'flex' : 'hidden',
					!immersive && 'shell-sidebar-column lg:sticky lg:bottom-auto lg:flex lg:max-w-none lg:shadow-sm'
				]}
			>
				<Sidebar role={viewer.role} {pathname} {shelves} {footer}>
					{#snippet account()}
						<div class="shell-account-rows shrink-0 border-t py-3 sm:hidden">
							<div class="flex flex-col gap-1 px-3">
								<LanguageMenu {onlocale} compact />
								<ThemeToggle compact />
							</div>
						</div>
					{/snippet}
				</Sidebar>
			</aside>
		{/if}
		<main id="main-content" tabindex="-1" class="min-w-0 flex-1 focus:outline-none">
			<!-- Regular pages render cards straight on the shell background; immersive routes keep their own panel. -->
			<div class={immersive
				? 'min-h-full rounded-2xl border border-zinc-200 bg-slate-50 px-4 py-6 text-slate-950 shadow-sm sm:px-6 sm:py-8 lg:px-8'
				: 'app-panel min-h-full text-slate-950'}>
				{@render children()}
			</div>
		</main>
	</div>
	{#if viewer && !immersive}<QuickViewHost admin={viewer.role === 'admin'} />{/if}
</div>
