<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { bookDisplay, updateBookDisplay } from '#lib/catalog/book-display.svelte.js';

	function updateSize(event: Event) {
		updateBookDisplay({ size: Number((event.currentTarget as HTMLInputElement).value) });
	}

	function updateSpacing(event: Event) {
		updateBookDisplay({ spacing: Number((event.currentTarget as HTMLInputElement).value) });
	}
</script>

<svelte:head>
	<title>{m['appearance.title']()} · {m['common.app_name']()}</title>
</svelte:head>

<section class="max-w-3xl space-y-5" aria-labelledby="appearance-heading">
	<header class="space-y-2">
		<h1 id="appearance-heading" class="text-3xl font-semibold tracking-tight">{m['appearance.title']()}</h1>
		<p class="text-slate-600">{m['appearance.description']()}</p>
	</header>
	<div class="card space-y-6 p-6">
		<label class="grid gap-2 text-sm" for="appearance-cover-size">
			<span class="font-medium">{m['organize.cover_size']()} <output>{bookDisplay.size}px</output></span>
			<input id="appearance-cover-size" type="range" min="100" max="280" step="1" value={bookDisplay.size} oninput={updateSize} />
		</label>
		<label class="grid gap-2 text-sm" for="appearance-spacing">
			<span class="font-medium">{m['organize.spacing']()} <output>{bookDisplay.spacing}px</output></span>
			<input id="appearance-spacing" type="range" min="0" max="48" step="2" value={bookDisplay.spacing} oninput={updateSpacing} />
		</label>
	</div>
	{#if bookDisplay.error}
		<p class="text-sm text-red-700" role="alert">{m['organize.display_error']()}</p>
	{/if}
</section>
