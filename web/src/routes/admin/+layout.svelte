<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import { adminErrorKey } from '#lib/admin/form.js';
	import { focusRing } from '#lib/admin/ui.js';
	import { translate } from '#lib/paging/translate.js';
	import { getSessionViewer } from '#lib/shelves/api.js';
	import { isAdministrator } from '#lib/shelves/form.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
	type Access = 'loading' | 'admin' | 'forbidden' | 'error';
	let access = $state<Access>('loading');
	let failure = $state<unknown>(null);
	let check = 0;

	onMount(() => {
		void checkAccess();
	});

	// This only decides what to render; every admin API request is authorized by the server.
	async function checkAccess() {
		const current = ++check;
		access = 'loading';
		failure = null;
		try {
			const viewer = await getSessionViewer();
			if (current !== check) return;
			access = isAdministrator(viewer) ? 'admin' : 'forbidden';
		} catch (cause) {
			if (current !== check) return;
			failure = cause;
			access = 'error';
		}
	}
</script>

{#if access === 'loading'}
	<p class="text-slate-600" role="status">{m['admin.checking']()}</p>
{:else if access === 'error'}
	<AdminAlert message={translate(adminErrorKey(failure, 'load'))} error={failure} onretry={checkAccess} />
{:else if access === 'forbidden'}
	<section class="space-y-3" aria-labelledby="admin-forbidden-heading">
		<h1 id="admin-forbidden-heading" class="text-3xl font-semibold tracking-tight">{m['admin.title']()}</h1>
		<p class="card p-4 text-slate-700" role="alert">{m['admin.forbidden']()}</p>
		<a class={`rounded-sm underline underline-offset-4 ${focusRing}`} href="/">{m['admin.back_home']()}</a>
	</section>
{:else}
	{@render children()}
{/if}
