<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';

	let { description }: { description: string } = $props();
</script>

<details class="text-sm text-slate-600">
	<summary class="w-fit cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-offset-2">{m['shelves.details']()}</summary>
	<p class="mt-2 whitespace-pre-wrap text-slate-700">{description}</p>
</details>
