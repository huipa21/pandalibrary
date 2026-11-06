<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import AdminAlert from '#lib/admin/AdminAlert.svelte';
	import { adminErrorKey } from '#lib/admin/form.js';
	import { focusRing } from '#lib/admin/ui.js';
	import BookheapPage from '#lib/bookheap/BookheapPage.svelte';
	import { translate } from '#lib/paging/translate.js';
	import { getSessionViewer } from '#lib/shelves/api.js';
	import { isAdministrator } from '#lib/shelves/form.js';

	type Access = 'loading' | 'admin' | 'forbidden' | 'error';
	let access = $state<Access>('loading');
	let failure = $state<unknown>(null);
	let check = 0;

	onMount(() => {
		void checkAccess();
		return () => {
			check += 1;
		};
	});

	// This only decides what to render; every Bookheap API request is authorized by the server.
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

<svelte:head>
	<title>{m['bh4.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-6" aria-labelledby="bookheap-heading">
	<header class="space-y-2">
		<h1 id="bookheap-heading" class="text-3xl font-semibold tracking-tight">{m['bh4.title']()}</h1>
		{#if access === 'admin'}<p class="text-slate-600">{m['bh4.description']()}</p>{/if}
	</header>
	{#if access === 'loading'}
		<p class="text-slate-600" role="status">{m['admin.checking']()}</p>
	{:else if access === 'error'}
		<AdminAlert message={translate(adminErrorKey(failure, 'load'))} error={failure} onretry={checkAccess} />
	{:else if access === 'forbidden'}
		<p class="rounded-md border border-slate-200 bg-white p-4 text-slate-700" role="alert">{m['admin.forbidden']()}</p>
		<a class={`rounded-sm underline underline-offset-4 ${focusRing}`} href="/">{m['admin.back_home']()}</a>
	{:else}
		<BookheapPage />
	{/if}
</section>
