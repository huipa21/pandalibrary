<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { ApiError } from '#lib/api/client.js';
	import { errorBox, linkClass } from './ui.js';

	let {
		message,
		error = null,
		onretry,
		retryLabel
	}: {
		message: string;
		/** The original failure, used only to offer a sign-in link after a 401. */
		error?: unknown;
		onretry?: () => void;
		retryLabel?: string;
	} = $props();

	const sessionExpired = $derived(error instanceof ApiError && error.status === 401);
</script>

<div class={`flex flex-wrap items-center gap-3 ${errorBox}`} role="alert">
	<p>{message}</p>
	{#if sessionExpired}
		<a class={linkClass} href="/login">{m['admin.sign_in']()}</a>
	{:else if onretry}
		<button type="button" class={linkClass} onclick={onretry}>{retryLabel ?? m['admin.retry']()}</button>
	{/if}
</div>
