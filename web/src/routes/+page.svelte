<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';

	// Temporary landing page owned by UX1. UX5 replaces it with the configurable dashboard.
	const destinations = [
		{ href: '/books', label: m['ux1.dashboard.all_books'] },
		{ href: '/libraries', label: m['ux1.dashboard.libraries'] },
		{ href: '/read', label: m['ux1.dashboard.read'] }
	];
</script>

<section class="space-y-6" data-temporary-dashboard>
	<header>
		<h1 class="text-3xl font-semibold tracking-tight">{m['ux1.dashboard.title']()}</h1>
		<p class="mt-2 text-slate-600">{m['ux1.dashboard.temporary']()}</p>
	</header>
	<ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
		{#each destinations as destination (destination.href)}
			<li>
				<a
					class="block rounded-xl border border-slate-200 bg-white p-5 font-medium shadow-sm transition hover:border-emerald-500 hover:shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
					href={destination.href}
				>{destination.label()}</a>
			</li>
		{/each}
	</ul>
</section>
