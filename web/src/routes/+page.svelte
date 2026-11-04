<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import Dashboard from '#lib/dashboard/Dashboard.svelte';
	import { offlineStatus } from '#lib/sync/client.js';
</script>

{#if $offlineStatus.account !== null}
	{#key $offlineStatus.account}
		<Dashboard account={$offlineStatus.account} />
	{/key}
{:else}
	<p class="text-slate-600" role="status">{m['auth.loading']()}</p>
{/if}
