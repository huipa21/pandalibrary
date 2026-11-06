<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { VersionState } from './version.js';

	let { state, onretry }: { state: VersionState; onretry: () => void } = $props();
</script>

<section aria-label={m['ux9.label']()} class="min-w-0 text-xs">
	{#if state.status === 'ready'}
		<p class="break-all opacity-80">{m['ux9.version']({
			version: `${state.info.commit_date.slice(2, 10).replaceAll('-', '')}-${state.info.commit.slice(0, 7)}`
		})}</p>
	{:else if state.status === 'loading'}
		<p role="status">{m['ux9.loading']()}</p>
	{:else}
		<p role="status">{state.status === 'offline' ? m['ux9.offline']() : m['ux9.error']()}</p>
		<button class="mt-1 underline focus-visible:outline-2 focus-visible:outline-offset-2" onclick={onretry}>
			{m['ux9.retry']()}
		</button>
	{/if}
</section>
