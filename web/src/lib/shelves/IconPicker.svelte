<script lang="ts">
	import Icon from '#lib/bookview/Icon.svelte';
	import { extraIcons, isExtraIcon } from '#lib/entity-icons.js';
	import { selectableIcons } from '#lib/navigation-icons.js';
	import * as m from '#lib/paraglide/messages.js';

	let { idPrefix, value = $bindable(''), disabled = false }: {
		idPrefix: string;
		value?: string;
		disabled?: boolean;
	} = $props();

	let expanded = $state(false);
	let trayWidth = $state(0);
	let automaticWidth = $state(0);
	let buttonWidth = $state(0);
	const visibleCount = $derived(buttonWidth
		? Math.max(0, Math.floor((trayWidth - automaticWidth - buttonWidth - buttonWidth * 2 / 11) / (buttonWidth * 13 / 11)))
		: 0);
	const visibleIcons = $derived.by(() => {
		if (expanded) return selectableIcons;
		const icons = selectableIcons.slice(0, visibleCount);
		const selected = selectableIcons.find((icon) => icon === value);
		if (selected && !icons.includes(selected) && icons.length) icons[icons.length - 1] = selected;
		return icons;
	});

	const labels = $derived({
		'book-open': m['entity_icon.book'](),
		bookmark: m['entity_icon.bookmark'](),
		star: m['entity_icon.star'](),
		'folder-plus': m['entity_icon.folder_plus'](),
		globe: m['entity_icon.globe'](),
		image: m['entity_icon.image'](),
		pen: m['entity_icon.pen'](),
		file: m['entity_icon.file'](),
		'list-tree': m['entity_icon.list'](),
		message: m['entity_icon.message'](),
		highlighter: m['entity_icon.highlighter'](),
		lock: m['entity_icon.lock'](),
		notebook: m['entity_icon.notebook'](),
		books: m['entity_icon.books'](),
		library: m['entity_icon.library'](),
		folder: m['entity_icon.plain_folder'](),
		home: m['entity_icon.home'](),
		inbox: m['entity_icon.inbox'](),
		chart: m['entity_icon.chart'](),
		clock: m['entity_icon.clock'](),
		users: m['entity_icon.users'](),
		pencil: m['entity_icon.pencil'](),
		eye: m['entity_icon.eye']()
	});

	function iconLabel(icon: (typeof selectableIcons)[number]) {
		return isExtraIcon(icon) ? extraIcons[icon].label() : labels[icon];
	}
</script>

<fieldset class="grid gap-2" {disabled}>
	<legend class="mb-2 text-sm font-medium">{m['entity_icon.label']()}</legend>
	<div class="flex items-start gap-2" bind:clientWidth={trayWidth}>
		<div id={`${idPrefix}-icon-tray`} class:overflow-y-auto={expanded} class:max-h-52={expanded} class="flex min-w-0 flex-1 flex-wrap gap-2">
		<label class="relative cursor-pointer" bind:clientWidth={automaticWidth}>
			<input class="peer absolute inset-0 size-full cursor-pointer opacity-0" type="radio" name={`${idPrefix}-icon`} value="" bind:group={value} />
			<span class="flex min-h-11 items-center rounded-md border border-slate-300 px-3 text-sm peer-checked:border-emerald-800 peer-checked:bg-emerald-50 peer-checked:ring-2 peer-checked:ring-emerald-800 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-disabled:opacity-50">{m['entity_icon.automatic']()}</span>
		</label>
		{#each visibleIcons as icon (icon)}
			<label class="relative cursor-pointer" title={iconLabel(icon)}>
				<input class="peer absolute inset-0 size-full cursor-pointer opacity-0" type="radio" name={`${idPrefix}-icon`} value={icon} bind:group={value} />
				<span class="flex size-11 items-center justify-center rounded-md border border-slate-300 peer-checked:border-emerald-800 peer-checked:bg-emerald-50 peer-checked:ring-2 peer-checked:ring-emerald-800 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-disabled:opacity-50">
					<Icon name={icon} />
					<span class="sr-only">{iconLabel(icon)}</span>
				</span>
			</label>
		{/each}
		</div>
		<button
			type="button"
			class="flex size-11 shrink-0 items-center justify-center rounded-md border border-slate-300 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
			bind:clientWidth={buttonWidth}
			aria-expanded={expanded}
			aria-controls={`${idPrefix}-icon-tray`}
			aria-label={expanded ? m['entity_icon.show_less']() : m['entity_icon.show_more']()}
			title={expanded ? m['entity_icon.show_less']() : m['entity_icon.show_more']()}
			onclick={() => expanded = !expanded}
		>
			<Icon name={expanded ? 'chevron-down' : 'more'} class={expanded ? 'size-5 rotate-180' : 'size-5'} />
		</button>
	</div>
</fieldset>
