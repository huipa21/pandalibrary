<script lang="ts">
	import type { BookFile } from '#lib/catalog/types.js';
	import { coverCloth, titleScale, truncateTitle } from './cover.js';
	import FormatBadge from './FormatBadge.svelte';

	interface Props {
		id: number;
		title: string;
		subtitle?: string | null;
		series?: string | null;
		authors?: readonly string[];
		coverUrl?: string | null;
		files?: readonly BookFile[];
		size?: 'xs' | 'sm' | 'md' | 'lg';
		badge?: boolean;
		class?: string;
		loading?: 'lazy' | 'eager';
	}

	let {
		id, title, subtitle = null, series = null, authors = [], coverUrl = null, files = [], size = 'md',
		badge = false, class: className = '', loading = 'lazy'
	}: Props = $props();
	let failed = $state(false);
	const cloth = $derived(coverCloth(id));
	const shortTitle = $derived(truncateTitle(title));
	const scale = $derived(titleScale(title));

	$effect(() => {
		coverUrl;
		failed = false;
	});
</script>

<div
	class={`book-cover relative aspect-book w-full overflow-hidden rounded-md ${className}`}
	style:--cover-board={cloth.board}
	style:--cover-spine={cloth.spine}
	style:--cover-frame={cloth.frame}
	style:--cover-plate={cloth.plate}
	style:--cover-plate-rule={cloth.plateRule}
	style:--cover-ink={cloth.ink}
	style:--cover-author={cloth.author}
>
	{#if coverUrl && !failed}
		<img class="h-full w-full bg-slate-100 object-cover" src={coverUrl} alt={title} {loading} onerror={() => (failed = true)} />
	{:else}
		<div
			class="generated-cover absolute inset-0 text-center"
			role="img"
			aria-label={title}
			data-generated-cover
		>
			<span class="cover-texture absolute inset-0" aria-hidden="true"></span>
			<span class="cover-spine absolute inset-y-0 left-0 w-[5%]" aria-hidden="true"></span>
			<span class="cloth-frame" aria-hidden="true"></span>
			<span class="cloth-frame cloth-frame-inner" aria-hidden="true"></span>
			<div class="cover-plate">
				{#if series && size !== 'xs'}
					<span class="cover-series">{series}</span>
					<span class="cover-rule" aria-hidden="true"></span>
				{/if}
				<span
					class:cover-title-small={size === 'xs' || size === 'sm'}
					class="cover-title font-serif font-bold"
					data-title-scale={scale}
				>{shortTitle}</span>
				{#if subtitle && size !== 'xs' && size !== 'sm'}
					<span class="cover-rule" aria-hidden="true"></span>
					<span class="cover-subtitle font-serif">{subtitle}</span>
				{/if}
			</div>
			{#if size !== 'xs'}
				<div class="cover-footer">
					<span aria-hidden="true">&mdash; &#9670; &mdash;</span>
					{#if authors[0]}<span class="cover-author">{authors[0]}</span>{/if}
				</div>
			{/if}
		</div>
	{/if}
	{#if badge}
		<div class="absolute top-2 left-2 max-w-[calc(100%-1rem)]">
			<FormatBadge {files} size={size === 'xs' || size === 'sm' ? 'xs' : 'sm'} />
		</div>
	{/if}
</div>

<style>
	.book-cover {
		container-type: inline-size;
		box-shadow: 0 1px 2px rgb(0 0 0 / 12%), 0 4px 12px rgb(0 0 0 / 10%);
	}

	.generated-cover {
		isolation: isolate;
		background:
			linear-gradient(180deg, rgb(255 255 255 / 10%), rgb(0 0 0 / 16%)),
			var(--cover-board);
	}

	.cover-texture {
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
		background-size: 128px 128px;
		mix-blend-mode: multiply;
		opacity: 0.18;
	}

	.cover-spine {
		background: var(--cover-spine);
		box-shadow: 1px 0 rgb(255 255 255 / 16%);
	}

	.cloth-frame {
		position: absolute;
		inset: 5%;
		border: 1px solid color-mix(in srgb, var(--cover-frame) 45%, transparent);
	}

	.cloth-frame-inner {
		inset: 6.5%;
	}

	.cover-plate {
		position: absolute;
		top: 30%;
		left: 11%;
		display: flex;
		width: 78%;
		max-height: 53%;
		flex-direction: column;
		align-items: center;
		gap: 2cqi;
		overflow: hidden;
		background: var(--cover-plate);
		padding: 5cqi 4cqi;
		color: var(--cover-ink);
		box-shadow: 0 1px 2px rgb(0 0 0 / 18%);
	}

	.cover-plate::after {
		position: absolute;
		inset: 3px;
		border: 1px solid var(--cover-plate-rule);
		content: '';
		pointer-events: none;
	}

	.cover-series,
	.cover-subtitle {
		width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.cover-series {
		font-size: 4.5cqi;
		font-weight: 600;
		letter-spacing: 0.12em;
		line-height: 1.1;
		opacity: 0.8;
		text-transform: uppercase;
	}

	.cover-rule {
		width: 28%;
		border-top: 1px solid var(--cover-plate-rule);
	}

	.cover-title {
		display: -webkit-box;
		width: 100%;
		overflow: hidden;
		overflow-wrap: anywhere;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 5;
		line-clamp: 5;
		line-height: 1.05;
		text-wrap: balance;
	}

	.cover-title[data-title-scale='xl'] { font-size: 17cqi; }
	.cover-title[data-title-scale='lg'] {
		/* The narrower existing serif fallback keeps medium-length words together. */
		font-family: 'Times New Roman', Times, serif;
		font-size: 12cqi;
	}
	.cover-title[data-title-scale='md'] { font-size: 9.5cqi; }
	.cover-title[data-title-scale='sm'] {
		max-width: 85%;
		font-size: 8cqi;
	}

	.cover-title-small {
		-webkit-line-clamp: 3;
		line-clamp: 3;
	}

	.cover-subtitle {
		font-size: 5cqi;
		font-style: italic;
		line-height: 1.1;
	}

	.cover-footer {
		position: absolute;
		bottom: 11%;
		left: 11%;
		display: flex;
		width: 78%;
		flex-direction: column;
		align-items: center;
		gap: 1cqi;
		color: var(--cover-author);
		font-size: 5cqi;
		line-height: 1.1;
	}

	.cover-author {
		width: 100%;
		overflow: hidden;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-overflow: ellipsis;
		text-transform: uppercase;
		white-space: nowrap;
	}
</style>
