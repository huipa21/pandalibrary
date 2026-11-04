<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { locales, localizeHref } from '#lib/paraglide/runtime.js';

	interface Props {
		pathname: string;
		viewer: { username: string; display_name: string } | null;
		onlogout: () => void;
		/** `header` lays the controls out in a row; `drawer` stacks them inside the small-screen sidebar. */
		variant: 'header' | 'drawer';
	}

	let { pathname, viewer, onlogout, variant }: Props = $props();
</script>

<div
	class={variant === 'header' ? 'flex items-center gap-4' : 'flex flex-wrap items-center gap-x-4 gap-y-2 px-6'}
	role="group"
	aria-label={m['ux1.account.label']()}
>
	{#if viewer}
		<span class={variant === 'header' ? 'hidden max-w-40 truncate text-sm text-zinc-400 xl:inline' : 'w-full truncate text-sm text-zinc-400'}>
			{viewer.display_name || viewer.username}
		</span>
		<a class="shell-control" href="/settings" aria-current={pathname === '/settings' ? 'page' : undefined}>{m['auth.navigation.settings']()}</a>
		<button class="shell-control" onclick={onlogout}>{m['auth.logout.submit']()}</button>
	{/if}
	<nav aria-label={m['catalog.language.navigation']()} class="flex gap-3">
		{#each locales as locale (locale)}
			<a class="shell-control" href={localizeHref(pathname, { locale })} hreflang={locale} lang={locale}>
				{locale === 'zh' ? m['common.language_chinese']() : m['common.language_english']()}
			</a>
		{/each}
	</nav>
</div>
