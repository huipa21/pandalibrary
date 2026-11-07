<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { QUICK_VIEW_EVENT, type QuickViewDetail } from '../events.js';
	import QuickViewDrawer from './QuickViewDrawer.svelte';

	let { admin = false }: { admin?: boolean } = $props();
	let request = $state.raw<QuickViewDetail | null>(null);

	function insideDrawer(element: Element | null): boolean {
		return element?.closest('[data-quick-view]') != null;
	}

	function openRequest(event: Event) {
		const detail = (event as CustomEvent<QuickViewDetail>).detail;
		if (!detail || !Number.isSafeInteger(detail.bookId) || detail.bookId < 1) return;
		// A replacement request keeps the original trigger so focus returns to the list.
		const trigger = request && (detail.trigger === null || insideDrawer(detail.trigger)) ? request.trigger : detail.trigger;
		request = { ...detail, trigger };
	}

	async function close(restoreFocus = true) {
		const trigger = request?.trigger;
		request = null;
		if (!restoreFocus) return;
		await tick();
		if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
	}

	onMount(() => {
		window.addEventListener(QUICK_VIEW_EVENT, openRequest);
		return () => window.removeEventListener(QUICK_VIEW_EVENT, openRequest);
	});

	afterNavigate(() => {
		if (request) void close(false);
	});
</script>

{#if request}
	<QuickViewDrawer bookId={request.bookId} seed={request.book} {admin} onclose={() => void close()} />
{/if}
