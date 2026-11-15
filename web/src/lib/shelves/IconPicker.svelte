<script lang="ts">
	import Icon from '#lib/bookview/Icon.svelte';
	import { selectableIcons } from '#lib/navigation-icons.js';
	import * as m from '#lib/paraglide/messages.js';

	let { idPrefix, value = $bindable(''), disabled = false }: {
		idPrefix: string;
		value?: string;
		disabled?: boolean;
	} = $props();

	const labels = $derived({
		'book-open': m['entity_icon.book'](),
		bookmark: m['entity_icon.bookmark'](),
		star: m['entity_icon.star'](),
		'folder-plus': m['entity_icon.folder'](),
		globe: m['entity_icon.globe'](),
		image: m['entity_icon.image'](),
		pen: m['entity_icon.pen'](),
		file: m['entity_icon.file'](),
		'list-tree': m['entity_icon.list'](),
		message: m['entity_icon.message'](),
		highlighter: m['entity_icon.highlighter'](),
		lock: m['entity_icon.lock']()
	});
</script>

<fieldset class="grid gap-2" {disabled}>
	<legend class="mb-2 text-sm font-medium">{m['entity_icon.label']()}</legend>
	<div class="flex flex-wrap gap-2">
		<label class="relative cursor-pointer">
			<input class="peer absolute inset-0 size-full cursor-pointer opacity-0" type="radio" name={`${idPrefix}-icon`} value="" bind:group={value} />
			<span class="flex min-h-11 items-center rounded-md border border-slate-300 px-3 text-sm peer-checked:border-emerald-800 peer-checked:bg-emerald-50 peer-checked:ring-2 peer-checked:ring-emerald-800 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-disabled:opacity-50">{m['entity_icon.automatic']()}</span>
		</label>
		{#each selectableIcons as icon}
			<label class="relative cursor-pointer" title={labels[icon]}>
				<input class="peer absolute inset-0 size-full cursor-pointer opacity-0" type="radio" name={`${idPrefix}-icon`} value={icon} bind:group={value} />
				<span class="flex size-11 items-center justify-center rounded-md border border-slate-300 peer-checked:border-emerald-800 peer-checked:bg-emerald-50 peer-checked:ring-2 peer-checked:ring-emerald-800 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-disabled:opacity-50">
					<Icon name={icon} />
					<span class="sr-only">{labels[icon]}</span>
				</span>
			</label>
		{/each}
	</div>
</fieldset>
