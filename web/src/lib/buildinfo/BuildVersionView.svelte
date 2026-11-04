<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { VersionState } from './version.js';

	let { state, onretry }: { state: VersionState; onretry: () => void } = $props();
</script>

<section aria-label={m['ux9.label']()} class="min-w-0 text-xs">
	{#if state.status === 'ready'}
		<details>
			<summary class="cursor-pointer break-all opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2">
				{m['ux9.version']({ version: state.info.version })}
			</summary>
			<dl class="mt-2 space-y-1">
				<div><dt class="font-semibold">{m['ux9.commit']()}</dt><dd class="break-all font-mono">{state.info.commit}</dd></div>
				<div>
					<dt class="font-semibold">{m['ux9.commit_date']()}</dt>
					<dd><time datetime={state.info.commit_date}>{state.info.commit_date}</time></dd>
				</div>
				<div><dt class="font-semibold">{m['ux9.dirty']()}</dt><dd>{state.info.dirty ? m['ux9.yes']() : m['ux9.no']()}</dd></div>
				{#if state.info.release}
					<div><dt class="font-semibold">{m['ux9.release']()}</dt><dd class="break-all">{state.info.release}</dd></div>
				{/if}
			</dl>
		</details>
	{:else if state.status === 'loading'}
		<p role="status">{m['ux9.loading']()}</p>
	{:else}
		<p role="status">{state.status === 'offline' ? m['ux9.offline']() : m['ux9.error']()}</p>
		<button class="mt-1 underline focus-visible:outline-2 focus-visible:outline-offset-2" onclick={onretry}>
			{m['ux9.retry']()}
		</button>
	{/if}
</section>
