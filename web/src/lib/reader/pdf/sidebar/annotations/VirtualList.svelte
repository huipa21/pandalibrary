<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import type { AnnotationEntry } from './annotations-list.js';
	import { ANNOTATION_ROW_HEIGHT, annotationWindow } from './virtual-window.js';
	import AnnotationRow from './AnnotationEntry.svelte';

	let { entries, scrollRoot, virtual, readonly = false, busy, target, onjump, onedit, ondelete, onexpand }: {
		entries: AnnotationEntry[];
		scrollRoot: HTMLElement | undefined;
		virtual: boolean;
		readonly?: boolean;
		busy: boolean;
		target: { id: string; seq: number } | null;
		onjump: (entry: AnnotationEntry) => Promise<boolean>;
		onedit?: (entry: AnnotationEntry, trigger: HTMLButtonElement) => void;
		ondelete: (entry: AnnotationEntry) => Promise<boolean>;
		onexpand: (entry: AnnotationEntry, trigger: HTMLButtonElement, readonly: boolean) => void;
	} = $props();
	let list = $state<HTMLUListElement>();
	let metrics = $state({ top: 0, height: 0, offset: 0 });
	let flashId = $state<string | null>(null);
	let flashTimer: ReturnType<typeof setTimeout> | undefined;
	let handled = 0;
	let focusVersion = 0;

	function measure() {
		if (!list || !scrollRoot) return;
		const offset = list.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top + scrollRoot.scrollTop;
		metrics = { top: scrollRoot.scrollTop - offset, height: scrollRoot.clientHeight, offset };
	}
	$effect(() => {
		const root = scrollRoot;
		const element = list;
		if (!root || !element) return;
		measure();
		root.addEventListener('scroll', measure, { passive: true });
		const observer = new ResizeObserver(measure);
		observer.observe(root);
		observer.observe(element);
		return () => { root.removeEventListener('scroll', measure); observer.disconnect(); };
	});

	const range = $derived.by(() => {
		if (!virtual) return { start: 0, end: entries.length };
		if (metrics.top + metrics.height < 0 || metrics.top > entries.length * ANNOTATION_ROW_HEIGHT) {
			return { start: 0, end: 0 };
		}
		return annotationWindow(entries.length, Math.max(0, metrics.top), metrics.height, true);
	});
	const visible = $derived(entries.slice(range.start, range.end));

	async function focusIndex(index: number, part: 'body' | 'expand', flash = false) {
		const root = scrollRoot;
		const id = entries[index]?.id;
		if (!root || !id) return;
		const version = ++focusVersion;
		measure();
		root.scrollTop = Math.max(0, metrics.offset + index * ANNOTATION_ROW_HEIGHT -
			Math.max(0, (root.clientHeight - ANNOTATION_ROW_HEIGHT) / 2));
		measure();
		await tick();
		if (version !== focusVersion) return;
		const item = [...(list?.querySelectorAll<HTMLElement>('[data-panel-entry]') ?? [])]
			.find((element) => element.dataset.panelEntry === id);
		const button = item?.querySelector<HTMLButtonElement>(part === 'body' && !readonly ? '[data-panel-jump]' : '[data-rp7-expand]');
		item?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
		button?.focus({ preventScroll: true });
		if (flash && item) {
			flashId = id;
			clearTimeout(flashTimer);
			flashTimer = setTimeout(() => { flashId = null; }, 1000);
		}
	}
	$effect(() => {
		const requested = target;
		if (!requested || requested.seq === handled || !scrollRoot || !list) return;
		const index = entries.findIndex((entry) => entry.id === requested.id);
		if (index < 0) return;
		handled = requested.seq;
		void focusIndex(index, 'body', true);
	});

	function onkey(event: KeyboardEvent, index: number, part: 'body' | 'edit' | 'delete' | 'expand') {
		if (!virtual || event.key !== 'Tab') return;
		if (!event.shiftKey && part === 'expand' && index === range.end - 1 && index + 1 < entries.length) {
			event.preventDefault();
			void focusIndex(index + 1, readonly ? 'expand' : 'body');
		} else if (event.shiftKey && part === (readonly ? 'expand' : 'body') && index === range.start && index > 0) {
			event.preventDefault();
			void focusIndex(index - 1, 'expand');
		}
	}
	onDestroy(() => { focusVersion += 1; clearTimeout(flashTimer); });
</script>

<ul class="rp7-list" bind:this={list}>
	{#if range.start}
		<li aria-hidden="true" role="presentation" style:height={`${range.start * ANNOTATION_ROW_HEIGHT}px`}></li>
	{/if}
	{#each visible as entry, offset (`${entry.kind}:${entry.id}`)}
		<AnnotationRow
			{entry}
			index={range.start + offset}
			size={entries.length}
			{busy}
			{readonly}
			flashed={flashId === entry.id}
			{onjump}
			{onedit}
			{ondelete}
			{onexpand}
			{onkey}
		/>
	{/each}
	{#if range.end < entries.length}
		<li aria-hidden="true" role="presentation" style:height={`${(entries.length - range.end) * ANNOTATION_ROW_HEIGHT}px`}></li>
	{/if}
</ul>
