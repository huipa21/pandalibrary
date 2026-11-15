<script lang="ts">
	import Icon, { type IconName } from '#lib/bookview/Icon.svelte';

	let { href, name, icon }: { href: string; name: string; icon: IconName } = $props();
</script>

<a
	{href}
	aria-label={name}
	class="group block rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-800"
>
	<div class="relative flex aspect-[2/3] flex-col items-center justify-center gap-5 overflow-hidden rounded-r-xl rounded-l-sm border border-emerald-900/20 bg-emerald-50 px-6 py-8 text-emerald-900 shadow-md transition group-hover:-translate-y-1 group-hover:shadow-lg">
		<span class="absolute inset-y-0 left-0 w-3 border-r border-emerald-900/15 bg-emerald-900/10" aria-hidden="true"></span>
		<Icon name={icon} class="size-12 shrink-0" />
		<span class="line-clamp-4 w-full text-center text-lg font-semibold break-words">{name}</span>
	</div>
</a>
