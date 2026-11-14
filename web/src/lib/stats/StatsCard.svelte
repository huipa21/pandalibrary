<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		description?: string;
		children: Snippet;
		class?: string;
	}

	let { title, description, children, class: className = '' }: Props = $props();
</script>

<section class={`card stats-card ${className}`} aria-label={title}>
	<header>
		<h2>{title}</h2>
		{#if description}<p>{description}</p>{/if}
	</header>
	<div class="content">{@render children()}</div>
</section>

<style>
	.stats-card { min-width: 0; color: #334155; }
	header { padding: 1rem 1.25rem; border-bottom: 1px solid #e2e8f0; }
	h2 { margin: 0; font-size: 0.9375rem; font-weight: 600; color: #0f172a; }
	p { margin: 0.375rem 0 0; font-size: 0.8125rem; line-height: 1.5; color: #64748b; }
	.content { display: grid; gap: 1rem; align-content: start; min-width: 0; padding: 1.25rem; }
	@media (max-width: 480px) {
		header { padding: 0.875rem 1rem; }
		.content { padding: 1rem; }
	}
</style>
