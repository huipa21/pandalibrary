<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { focusRing, panelClass } from '#lib/admin/ui.js';

	const cards = [
		{ href: '/admin/users', title: m['admin.tabs.users'], description: m['admin.overview.users'] },
		{ href: '/admin/libraries', title: m['admin.tabs.libraries'], description: m['admin.overview.libraries'] },
		{ href: '/admin/hidden-books', title: m['admin.tabs.hidden_books'], description: m['admin.overview.hidden_books'] },
		{ href: '/admin/imports', title: m['admin.tabs.imports'], description: m['admin.overview.imports'] },
		{ href: '/admin/providers', title: m['admin.tabs.providers'], description: m['admin.overview.providers'] },
		{ href: '/admin/maintenance', title: m['admin.tabs.maintenance'], description: m['admin.overview.maintenance'] }
	];
</script>

<svelte:head>
	<title>{m['admin.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="space-y-8" aria-labelledby="admin-heading">
	<h1 id="admin-heading" class="sr-only">{m['admin.title']()}</h1>

	<ul class="grid gap-3 sm:grid-cols-2">
		{#each cards as card (card.href)}
			<li class="rounded-lg border border-slate-200 bg-white p-4">
				<h2 class="font-semibold">
					<a class={`rounded-sm underline-offset-4 hover:underline ${focusRing}`} href={card.href}>{card.title()}</a>
				</h2>
				<p class="mt-1 text-sm text-slate-600">{card.description()}</p>
			</li>
		{/each}
	</ul>

	<section class={panelClass} aria-labelledby="admin-accounts-heading">
		<h2 id="admin-accounts-heading" class="text-xl font-semibold">{m['admin.accounts.heading']()}</h2>
		<p class="text-slate-700">{m['admin.accounts.cli']()}</p>
		<a class={`rounded-sm underline ${focusRing}`} href="/admin/users">{m['ux8.manage_accounts']()}</a>
		<ul class="list-disc space-y-1 pl-6 text-sm text-slate-700">
			<li><code class="rounded bg-slate-100 px-1">pandalibrary user create --username &lt;name&gt;</code></li>
			<li><code class="rounded bg-slate-100 px-1">pandalibrary user reset-password --username &lt;name&gt;</code></li>
		</ul>
		<p class="text-sm text-slate-600">{m['admin.accounts.ids']()}</p>
	</section>
</section>
