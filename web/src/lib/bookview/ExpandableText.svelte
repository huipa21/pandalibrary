<script lang="ts">
	import DOMPurify from 'dompurify';
	import { onMount, tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';

	let { text, lines = 4 }: { text: string; lines?: number } = $props();
	let clean = $state('');
	let expanded = $state(false);
	let overflowing = $state(false);
	let element = $state<HTMLParagraphElement | null>(null);
	const lineCount = $derived.by(() => {
		if (!Number.isSafeInteger(lines) || lines < 1) throw new RangeError('Line count must be a positive integer.');
		return lines;
	});

	function measure() {
		if (element && !expanded) overflowing = element.scrollHeight > element.clientHeight + 1;
	}

	$effect(() => {
		clean = DOMPurify.sanitize(text, { ALLOWED_TAGS: [], RETURN_DOM_FRAGMENT: true }).textContent ?? '';
		expanded = false;
	});

	$effect(() => {
		clean;
		lineCount;
		expanded;
		void tick().then(measure);
	});

	onMount(() => {
		const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
		if (element) observer?.observe(element);
		window.addEventListener('resize', measure);
		void document.fonts?.ready.then(measure);
		return () => {
			observer?.disconnect();
			window.removeEventListener('resize', measure);
		};
	});
</script>

<div>
	<p bind:this={element} class:clamped={!expanded} class="description" style={`--line-count: ${lineCount}`}>{clean}</p>
	{#if overflowing}
		<button
			type="button"
			class="mt-1 rounded text-sm font-medium text-emerald-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-emerald-700"
			aria-expanded={expanded}
			onclick={() => (expanded = !expanded)}
		>{expanded ? m['bv3.show_less']() : m['bv3.show_more']()}</button>
	{/if}
</div>

<style>
	.description {
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.clamped {
		display: -webkit-box;
		overflow: hidden;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: var(--line-count);
		line-clamp: var(--line-count);
	}
</style>
