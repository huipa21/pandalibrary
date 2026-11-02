<script lang="ts">
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { locales, localizeHref } from '#lib/paraglide/runtime.js';
	import './layout.css';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<title>{m['common.app_name']()}</title>
	<meta name="description" content={m['home.description']()} />
</svelte:head>

<div class="min-h-screen bg-slate-50 text-slate-950">
	<header class="border-b border-slate-200 bg-white">
		<div class="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
			<a class="font-semibold tracking-tight" href="/">{m['common.app_name']()}</a>
			<nav aria-label="Language" class="flex gap-4 text-sm">
				{#each locales as locale (locale)}
					<a
						class="text-slate-600 underline-offset-4 hover:text-slate-950 hover:underline"
						href={localizeHref(page.url.pathname, { locale })}
						hreflang={locale}
						lang={locale}
					>
						{locale === 'zh'
							? m['common.language_chinese']()
							: m['common.language_english']()}
					</a>
				{/each}
			</nav>
		</div>
	</header>
	<main class="mx-auto max-w-5xl px-6 py-16">
		{@render children()}
	</main>
</div>
