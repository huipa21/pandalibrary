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
		: m['offline.status.pending']()
	);
	let button = $state<HTMLButtonElement>();
	let panel = $state<HTMLDivElement>();

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

<svelte:window onpointerdown={outside} onkeydown={keydown} />

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
			onclick={() => open = !open}
		>
			<span class={['size-2 rounded-full', failed ? 'bg-red-500' : 'bg-amber-500']} aria-hidden="true"></span>
			<span class="sr-only" role="status">{message}</span>
		</button>
		{#if open}
			<div bind:this={panel} id="reader-sync-status" class="absolute right-0 top-full z-30 w-64 max-w-[calc(100vw-1rem)] space-y-3 rounded-md border border-[var(--shell-border)] bg-[var(--pv-chrome)] p-3 text-sm shadow-lg">
				<p>{message}</p>
				{#if retryError}<p role="alert">{m['offline.status.failed']()}</p>{/if}
				{#if $offlineStatus.available && $offlineStatus.online}
					<button class="underline focus-visible:outline-2 focus-visible:outline-emerald-500" disabled={$offlineStatus.syncing} onclick={retry}>{m['offline.retry_sync']()}</button>
				{/if}
			</div>
		{/if}
	</div>
{/if}
