<script lang="ts">
	import { showLoadingAfterDelay } from '#lib/ui/deferred.js';
	import * as m from '#lib/paraglide/messages.js';
	import Dashboard from '#lib/dashboard/Dashboard.svelte';
	import { offlineStatus } from '#lib/sync/client.js';
</script>

{#if $offlineStatus.account !== null}
	{#key $offlineStatus.account}
		<Dashboard account={$offlineStatus.account} />
	{/key}
{:else}
	<p use:showLoadingAfterDelay class="text-slate-600" role="status">{m['auth.loading']()}</p>
{/if}
