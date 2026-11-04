<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { CursorPager } from '#lib/paging/CursorPager.svelte.js';
	import { translate } from '#lib/paging/translate.js';
	import AdminAlert from './AdminAlert.svelte';
	import { adminErrorKey } from './form.js';
	import { primaryButton } from './ui.js';

	let { pager, loadMoreLabel }: { pager: CursorPager<unknown>; loadMoreLabel: string } = $props();
</script>

{#if pager.moreError}
	{#if adminErrorKey(pager.moreError, 'more') === 'admin.error.stale_cursor'}
		<AdminAlert message={m['admin.error.stale_cursor']()} onretry={() => pager.reload()} retryLabel={m['admin.restart_list']()} />
	{:else}
		<AdminAlert message={translate(adminErrorKey(pager.moreError, 'more'))} error={pager.moreError} onretry={() => pager.loadMore()} />
	{/if}
{/if}
{#if pager.hasMore}
	<button type="button" class={primaryButton} disabled={pager.loadingMore} onclick={() => pager.loadMore()}>
		{pager.loadingMore ? m['admin.loading_more']() : loadMoreLabel}
	</button>
{:else if pager.ended && pager.items.length > 0}
	<p class="text-sm text-slate-500" role="status">{m['admin.list_end']()}</p>
{/if}
