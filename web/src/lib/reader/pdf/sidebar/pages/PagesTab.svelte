<script lang="ts">
	import { onMount, tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { spreadStart } from '../../layout.js';
	import { getPdfReaderContext } from '../../context.js';
	import type { PdfViewState } from '../../types.js';
	import '#lib/reader/pdf/appearance.css';
	import { renderThumbnail } from './thumbnail-renderer.js';
	import { ThumbCache } from './thumb-cache.js';
	import { ThumbnailQueue } from './thumbnail-queue.js';

	const INITIAL_PAGE_BATCH = 24;
	const PAGE_BATCH_SIZE = 100;

	const ctx = getPdfReaderContext();
	const cache = new ThumbCache();
	const queue = new ThumbnailQueue(2);
	let currentPdf = ctx.engine.pdf;
	let viewState = $state<PdfViewState>(ctx.engine.state);
	let scroller = $state<HTMLDivElement>();
	let observer: IntersectionObserver | null = null;
	let appearanceObserver: MutationObserver | null = null;
	let background = $state<string | undefined>();
	let tone = $state<string | undefined>();
	let thumbnails = $state(new Map<number, ImageBitmap>());
	let aspects = $state<Record<number, number>>({});
	let focusedPage = $state(ctx.engine.state.page);
	let renderedPageCount = $state(INITIAL_PAGE_BATCH);
	let batchFrame: number | null = null;
	const pages = $derived(Array.from(
		{ length: Math.min(renderedPageCount, viewState.pageCount) },
		(_, index) => index + 1
	));
	const currentPages = $derived.by(() => {
		if (!viewState.pageCount) return new Set<number>();
		if (viewState.layout !== 'split' && viewState.layout !== 'split-continuous') return new Set([viewState.page]);
		const first = spreadStart(viewState.page, viewState.layout);
		return new Set([first, Math.min(viewState.pageCount, first + 1)]);
	});

	const pageNodes = new Map<number, HTMLButtonElement>();
	const pageForNode = new WeakMap<Element, number>();
	const nearby = new Map<number, { visible: boolean; distance: number }>();

	// Allow the first thumbnails to paint before mounting the rest of a long list.
	function scheduleMorePages() {
		if (batchFrame !== null || renderedPageCount >= viewState.pageCount) return;
		batchFrame = requestAnimationFrame(() => {
			batchFrame = null;
			renderedPageCount = Math.min(renderedPageCount + PAGE_BATCH_SIZE, viewState.pageCount);
			scheduleMorePages();
		});
	}

	function updateAppearance() {
		const viewport = ctx.engine.viewport;
		background = viewport.dataset.background;
		tone = viewport.dataset.tone;
	}

	function isAbort(error: unknown): boolean {
		return error instanceof DOMException && error.name === 'AbortError';
	}

	function reportRenderError(error: unknown) {
		if (isAbort(error)) return;
		console.error('Could not render a PDF page thumbnail', error);
		ctx.announce(m['reader.error.render']());
	}

	function queuePage(page: number, priority: { visible: boolean; distance: number }) {
		const rotation = viewState.rotation;
		const cached = cache.get(page, rotation);
		if (cached) {
			thumbnails = new Map(thumbnails).set(page, cached);
			return;
		}
		const pdf = ctx.engine.pdf;
		if (!pdf) return;
		void queue.enqueue(page, { ...priority, currentPage: viewState.page }, (signal) =>
			renderThumbnail(pdf, page, {
				width: 160,
				rotation,
				dpr: window.devicePixelRatio || 1,
				signal
			})
		).then((bitmap) => {
			if (viewState.rotation !== rotation) {
				bitmap.close();
				return;
			}
			cache.set(page, rotation, bitmap);
			thumbnails = new Map(thumbnails).set(page, bitmap);
			aspects = { ...aspects, [page]: bitmap.width / bitmap.height };
		}, reportRenderError);
	}

	function registerThumbnail(node: HTMLButtonElement, page: number) {
		pageNodes.set(page, node);
		pageForNode.set(node, page);
		observer?.observe(node);
		if (page === viewState.page) node.scrollIntoView({ block: 'nearest' });
		return {
			destroy() {
				observer?.unobserve(node);
				nearby.delete(page);
				queue.cancel(page);
				pageNodes.delete(page);
				pageForNode.delete(node);
			}
		};
	}

	function observeIntersections(entries: IntersectionObserverEntry[]) {
		if (!scroller) return;
		const root = scroller.getBoundingClientRect();
		const rootCenter = (root.top + root.bottom) / 2;
		for (const entry of entries) {
			const page = pageForNode.get(entry.target);
			if (page === undefined) continue;
			if (!entry.isIntersecting) {
				nearby.delete(page);
				queue.cancel(page);
				if (thumbnails.has(page)) {
					thumbnails = new Map(thumbnails);
					thumbnails.delete(page);
				}
				continue;
			}
			const bounds = entry.boundingClientRect;
			const visible = bounds.bottom > root.top && bounds.top < root.bottom;
			const distance = Math.abs((bounds.top + bounds.bottom) / 2 - rootCenter);
			const priority = { visible, distance };
			nearby.set(page, priority);
			queuePage(page, priority);
		}
	}

	function refreshNearby() {
		for (const [page, priority] of nearby) queuePage(page, priority);
	}

	function jump(page: number) {
		focusedPage = page;
		void ctx.engine.goToPage(page).then(() => {
			if (!ctx.sidebar.docked) ctx.sidebar.collapse();
		}).catch(reportRenderError);
	}

	function onThumbnailKeydown(event: KeyboardEvent, page: number) {
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
		event.preventDefault();
		const next = Math.min(viewState.pageCount, Math.max(1, page + (event.key === 'ArrowDown' ? 1 : -1)));
		focusedPage = next;
		const target = pageNodes.get(next);
		if (target) target.focus();
		else {
			renderedPageCount = Math.max(renderedPageCount, next);
			void tick().then(() => pageNodes.get(next)?.focus());
		}
	}

	function drawThumbnail(node: HTMLCanvasElement, bitmap: ImageBitmap | undefined) {
		function draw(next: ImageBitmap | undefined) {
			if (!next) return;
			node.width = next.width;
			node.height = next.height;
			const context = node.getContext('2d');
			if (!context) throw new Error('A 2D canvas context is unavailable for the PDF thumbnail.');
			context.drawImage(next, 0, 0);
		}
		draw(bitmap);
		return { update: draw };
	}

	$effect(() => {
		const current = viewState.page;
		pageNodes.get(current)?.scrollIntoView({ block: 'nearest' });
	});

	onMount(() => {
		if (!scroller) throw new Error('The Pages tab scroller did not mount.');
		const unsubscribe = ctx.engine.subscribe((next) => {
			const rotationChanged = next.rotation !== viewState.rotation;
			const pageChanged = next.page !== viewState.page;
			const pdf = ctx.engine.pdf;
			const documentChanged = pdf !== currentPdf;
			viewState = next;
			if (documentChanged || rotationChanged) {
				currentPdf = pdf;
				queue.cancelAll();
				cache.clear();
				thumbnails = new Map();
				aspects = {};
			}
			if (documentChanged) {
				renderedPageCount = INITIAL_PAGE_BATCH;
				nearby.clear();
				observer?.disconnect();
				for (const node of pageNodes.values()) observer?.observe(node);
			}
			if (pageChanged) focusedPage = next.page;
			if (pageChanged || documentChanged || rotationChanged) refreshNearby();
			scheduleMorePages();
		});
		pageNodes.get(viewState.page)?.scrollIntoView({ block: 'nearest' });
		observer = new IntersectionObserver(observeIntersections, {
			root: scroller,
			rootMargin: '400px'
		});
		for (const node of pageNodes.values()) observer.observe(node);

		updateAppearance();
		appearanceObserver = new MutationObserver(updateAppearance);
		appearanceObserver.observe(ctx.engine.viewport, {
			attributes: true,
			attributeFilter: ['data-background', 'data-tone']
		});

		return () => {
			unsubscribe();
			if (batchFrame !== null) cancelAnimationFrame(batchFrame);
			observer?.disconnect();
			observer = null;
			appearanceObserver?.disconnect();
			appearanceObserver = null;
			queue.cancelAll();
			cache.clear();
			thumbnails = new Map();
			nearby.clear();
			pageNodes.clear();
		};
	});
</script>

<div
	class="reader-pdf pv-pages-scroll"
	bind:this={scroller}
	data-background={background}
	data-tone={tone}
	role="list"
	aria-label={m['rp6.pages']()}
>
	{#each pages as page (page)}
		{@const bitmap = thumbnails.get(page)}
		<div class="pv-pages-item" role="listitem" aria-posinset={page} aria-setsize={viewState.pageCount}>
			<button
				use:registerThumbnail={page}
				class="pv-pages-button"
				class:pv-pages-current={currentPages.has(page)}
				type="button"
				aria-label={m['rp6.page']({ page })}
				aria-current={currentPages.has(page) ? 'page' : undefined}
				tabindex={focusedPage === page ? 0 : -1}
				onclick={() => jump(page)}
				onkeydown={(event) => onThumbnailKeydown(event, page)}
			>
				<div
					class="pv-pages-frame"
					style:aspect-ratio={aspects[page] ?? 0.77}
				>
					<div class="pdfViewer removePageBorders pv-pages-viewer">
						<div class="page pv-pages-page" data-number={bitmap ? undefined : page}>
							{#if bitmap}
								<canvas class="pv-pages-canvas" use:drawThumbnail={bitmap} aria-hidden="true"></canvas>
							{/if}
						</div>
					</div>
				</div>
			</button>
		</div>
	{/each}
</div>

<style>
	.pv-pages-scroll {
		height: 100%;
		overflow: auto;
		padding: 12px 16px;
		scrollbar-gutter: stable;
	}

	.pv-pages-scroll.reader-pdf,
	.pv-pages-scroll.reader-pdf[data-background][data-tone] {
		background: var(--shell-surface);
	}

	.pv-pages-item {
		display: flex;
		justify-content: center;
		margin-block: 0 16px;
	}

	.pv-pages-button {
		display: block;
		width: min(100%, 200px);
		padding: 0;
		border: 0;
		border-radius: 2px;
		background: transparent;
		cursor: pointer;
	}

	.pv-pages-button:focus-visible {
		outline: 2px solid #059669;
		outline-offset: 3px;
	}

	.pv-pages-button.pv-pages-current {
		outline: 2px solid #059669;
		outline-offset: -2px;
	}

	.pv-pages-frame {
		position: relative;
		width: 100%;
		overflow: hidden;
		background: var(--rp-page, white);
		box-shadow: 0 1px 5px rgb(0 0 0 / 18%);
	}

	.pv-pages-viewer {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}

	.pv-pages-page {
		position: relative;
		width: 100%;
		height: 100%;
		margin: 0;
		overflow: hidden;
	}

	.pv-pages-page[data-number]::before {
		content: attr(data-number);
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		color: #52525b;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
	}

	.pv-pages-canvas {
		display: block;
		width: 100%;
		height: 100%;
	}
</style>
