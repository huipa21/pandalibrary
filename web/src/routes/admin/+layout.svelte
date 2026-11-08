<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
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

	const sections = [
		{ href: '/admin', label: m['admin.tabs.overview'] },
		{ href: '/admin/users', label: m['admin.tabs.users'] },
		{ href: '/admin/libraries', label: m['admin.tabs.libraries'] },
		{ href: '/admin/hidden-books', label: m['admin.tabs.hidden_books'] },
		{ href: '/admin/imports', label: m['admin.tabs.imports'] },
		{ href: '/admin/providers', label: m['admin.tabs.providers'] },
		{ href: '/admin/maintenance', label: m['admin.tabs.maintenance'] }
	];

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

	function isCurrent(href: string): boolean {
		const path = page.url.pathname.replace(/\/+$/, '') || '/';
		return href === '/admin' ? path === '/admin' : path === href || path.startsWith(`${href}/`);
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
	<div class="space-y-8">
		<nav aria-label={m['admin.tabs.label']()} class="overflow-x-auto border-b border-slate-200">
			<ul class="flex min-w-max gap-1 text-sm">
				{#each sections as section (section.href)}
					<li>
						<a
							class={`-mb-px block rounded-t-md border-b-2 px-3 py-2 ${focusRing} ${isCurrent(section.href) ? 'border-slate-900 font-medium text-slate-950' : 'border-transparent text-slate-600 hover:text-slate-950'}`}
							href={section.href}
							aria-current={isCurrent(section.href) ? 'page' : undefined}
						>{section.label()}</a>
					</li>
				{/each}
			</ul>
		</nav>
		{@render children()}
	</div>
{/if}
