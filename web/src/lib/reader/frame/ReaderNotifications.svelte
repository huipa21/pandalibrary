<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';

	let { pendingError = '', errors = [], message = '', loading = false, bookHref, onretry }: {
		pendingError?: string;
		errors?: string[];
		message?: string;
		loading?: boolean;
		bookHref: string;
		onretry: () => Promise<void>;
	} = $props();
</script>

{#if pendingError || errors.some(Boolean) || message || loading}
	<div class="reader-notifications reader-alert">
		{#if pendingError}
			<div role="alert" class="reader-notification-error">
				<p>{pendingError}</p>
				<div class="reader-notification-actions">
					<button type="button" onclick={onretry}>{m['reader.retry_saves']()}</button>
					<a href={bookHref}>{m['reader.leave_unsaved']()}</a>
				</div>
			</div>
		{/if}
		{#each errors.filter(Boolean) as error}<p role="alert">{error}</p>{/each}
		{#if message}<p role="status">{message}</p>{/if}
		{#if loading}<p role="status">{m['reader.loading']()}</p>{/if}
	</div>
{/if}

<style>
	.reader-notifications {
		min-width: 0;
		max-height: 25dvh;
		overflow: auto;
		overscroll-behavior: contain;
		padding: 8px 12px;
		border-top: 1px solid var(--shell-border);
		background: var(--pv-chrome);
		color: var(--shell-text);
		font-size: 13px;
		line-height: 1.5;
		overflow-wrap: anywhere;
	}
	.reader-notification-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 16px;
	}
	.reader-notification-actions :is(button, a) {
		padding-block: 4px;
		text-decoration: underline;
	}
	.reader-notification-actions :is(button, a):focus-visible {
		outline: 2px solid var(--shell-accent, #059669);
		outline-offset: 2px;
	}
</style>
