<script lang="ts">
	import type { BookFile } from '#lib/catalog/types.js';
	import { coverTone, truncateTitle } from './cover.js';
	import FormatBadge from './FormatBadge.svelte';

	interface Props {
		id: number;
		title: string;
		authors?: readonly string[];
		coverUrl?: string | null;
		files?: readonly BookFile[];
		size?: 'sm' | 'md' | 'lg';
		badge?: boolean;
		class?: string;
		loading?: 'lazy' | 'eager';
	}

	let {
		id, title, authors = [], coverUrl = null, files = [], size = 'md',
		badge = false, class: className = '', loading = 'lazy'
	}: Props = $props();
	let failed = $state(false);
	const tone = $derived(coverTone(id));
	const shortTitle = $derived(truncateTitle(title));

	$effect(() => {
		coverUrl;
		failed = false;
	});
</script>

<div class={`book-cover relative aspect-[3/4] w-full overflow-hidden rounded-lg ${className}`}>
	{#if coverUrl && !failed}
		<img class="h-full w-full bg-slate-100 object-cover" src={coverUrl} alt={title} {loading} onerror={() => (failed = true)} />
	{:else}
		<div
			class={`generated-cover absolute inset-0 flex flex-col items-center justify-center text-center ${tone.bg} ${tone.text}`}
			role="img"
			aria-label={title}
			data-generated-cover
		>
			<span class={`absolute inset-y-0 left-0 w-[6%] ${tone.spine}`} aria-hidden="true"></span>
			<span class={`cover-accent mb-[8%] h-[1.5%] w-[24%] rounded-full ${tone.accent}`} aria-hidden="true"></span>
			<span class:cover-title-small={size === 'sm'} class="cover-title font-serif font-semibold">{shortTitle}</span>
			{#if authors[0]}
				<span class="cover-author mt-[9%] w-full truncate font-medium">{authors[0]}</span>
			{/if}
		</div>
	{/if}
	{#if badge}
		<div class="absolute top-2 left-2 max-w-[calc(100%-1rem)]">
			<FormatBadge {files} size={size === 'sm' ? 'xs' : 'sm'} />
		</div>
	{/if}
</div>

<style>
	.book-cover {
		container-type: inline-size;
	}

	.generated-cover {
		padding: 10% 12% 10% 16%;
	}

	.cover-title {
		display: -webkit-box;
		overflow: hidden;
		overflow-wrap: anywhere;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 5;
		line-clamp: 5;
		font-size: clamp(0.65rem, 9.5cqi, 2rem);
		line-height: 1.13;
		text-wrap: balance;
	}

	.cover-title-small {
		-webkit-line-clamp: 3;
		line-clamp: 3;
	}

	.cover-author {
		font-size: clamp(0.55rem, 5.5cqi, 1rem);
		line-height: 1.2;
	}
</style>
