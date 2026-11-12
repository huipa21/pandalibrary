<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { offlineStatus, syncNow } from '#lib/sync/client.js';

	let { warning = '', onretry }: { warning?: string; onretry?: () => Promise<void> } = $props();
	let open = $state(false);
	let retryError = $state(false);
	const visible = $derived(warning || !$offlineStatus.available || !$offlineStatus.online || $offlineStatus.pending > 0 || $offlineStatus.issues > 0 || $offlineStatus.error);
	const failed = $derived(warning || $offlineStatus.error || $offlineStatus.issues > 0 || !$offlineStatus.available);
	const message = $derived(
		warning ? warning : !$offlineStatus.available ? m['offline.status.unavailable']()
		: !$offlineStatus.online ? m['offline.status.offline']()
		: $offlineStatus.issues ? m['offline.status.conflict']()
		: $offlineStatus.error ? m['offline.status.failed']()
		: !$offlineStatus.pending ? m['offline.status.synced']()
		: m['offline.status.pending']()
	);
	let button = $state<HTMLButtonElement>();
	let panel = $state<HTMLDivElement>();
	let panelLeft = $state(8);
	let panelTop = $state(44);

	$effect(() => {
		if (!visible) open = false;
	});

	function positionPanel() {
		if (!open || !button) return;
		const rect = button.getBoundingClientRect();
		panelLeft = Math.max(8, Math.min(rect.left, window.innerWidth - 264));
		panelTop = rect.bottom + 4;
	}

	function outside(event: PointerEvent) {
		if (event.target instanceof Node && !panel?.contains(event.target) && !button?.contains(event.target)) open = false;
	}
	function keydown(event: KeyboardEvent) {
		if (open && event.key === 'Escape') {
			open = false;
			button?.focus();
		}
	}
	async function retry() {
		retryError = false;
		try {
			if (onretry) await onretry();
			else await syncNow(true);
		} catch (error) {
			console.error('Could not retry reader synchronization', error);
			retryError = true;
		}
	}
</script>

<svelte:window onpointerdown={outside} onkeydown={keydown} onresize={positionPanel} />

{#if visible}
	<div class="relative">
		<button
			bind:this={button}
			type="button"
			class="grid size-9 place-items-center rounded-full border-0 hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-emerald-500"
			aria-label={m['pv1.sync_status']()}
			title={message}
			aria-expanded={open}
			aria-controls="reader-sync-status"
			onclick={() => { open = !open; positionPanel(); }}
		>
			<span class={['size-2 rounded-full', failed ? 'bg-red-500' : 'bg-amber-500']} aria-hidden="true"></span>
			<span class="sr-only" role="status">{message}</span>
		</button>
		{#if open}
			<div bind:this={panel} id="reader-sync-status"
				style:left={`${panelLeft}px`} style:top={`${panelTop}px`}
				style:max-height={`calc(100dvh - ${panelTop + 8}px)`}
				class="fixed z-30 w-64 max-w-[calc(100vw-1rem)] space-y-3 overflow-auto rounded-md border border-[var(--shell-border)] bg-[var(--pv-chrome)] p-3 text-sm shadow-lg">
				<p>{message}</p>
				{#if $offlineStatus.errorDetail}<p role="alert">{$offlineStatus.errorDetail}</p>{/if}
				{#if retryError}<p role="alert">{m['offline.status.failed']()}</p>{/if}
				{#if $offlineStatus.issues}
					<a class="block underline focus-visible:outline-2 focus-visible:outline-emerald-500" href="/settings#offline-storage-heading">{m['offline.outbox.review']()}</a>
				{/if}
				{#if $offlineStatus.available && $offlineStatus.online}
					<button class="underline focus-visible:outline-2 focus-visible:outline-emerald-500" disabled={$offlineStatus.syncing} onclick={retry}>{m['offline.retry_sync']()}</button>
				{/if}
			</div>
		{/if}
	</div>
{/if}
