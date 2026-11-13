<script lang="ts">
	import { untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import HeaderMenu from '#lib/shell/HeaderMenu.svelte';

	let { storageKey, size = $bindable(208), spacing = $bindable(20) }: {
		storageKey: string;
		size?: number;
		spacing?: number;
	} = $props();
	let error = $state('');
	let panel = $state<HTMLDivElement | null>(null);
	const id = $props.id();

	$effect(() => {
		const key = `pandalibrary.display:${storageKey}`;
		untrack(() => {
			size = 208;
			spacing = 20;
			error = '';
			try {
				const stored = localStorage.getItem(key);
				if (stored === null) return;
				const saved: unknown = JSON.parse(stored);
				if (typeof saved !== 'object' || saved === null ||
					!('size' in saved) || typeof saved.size !== 'number' ||
					!('spacing' in saved) || typeof saved.spacing !== 'number' ||
					!Number.isInteger(saved.size) || saved.size < 100 || saved.size > 280 ||
					!Number.isInteger(saved.spacing) || saved.spacing < 0 || saved.spacing > 48) {
					throw new Error('Invalid saved book display settings');
				}
				size = saved.size;
				spacing = saved.spacing;
			} catch (cause) {
				console.error('Could not restore book display settings', cause);
				error = m['organize.display_error']();
			}
		});
	});

	function save() {
		error = '';
		try {
			localStorage.setItem(`pandalibrary.display:${storageKey}`, JSON.stringify({ size, spacing }));
		} catch (cause) {
			console.error('Could not save book display settings', cause);
			error = m['organize.display_error']();
		}
	}

	function positionPanel() {
		const popup = panel?.parentElement;
		if (!popup) return;
		popup.style.right = '0px';
		const bounds = popup.getBoundingClientRect();
		const left = Math.max(8, Math.min(bounds.left, window.innerWidth - bounds.width - 8));
		popup.style.right = `${bounds.left - left}px`;
	}

	function openPanel() {
		positionPanel();
		panel?.querySelector('input')?.focus();
	}
</script>

<svelte:window onresize={positionPanel} />

<div class="space-y-2">
	<HeaderMenu menuId={`book-display-${storageKey}`} popup="dialog" label={m['organize.display']()} panelClass="w-72 max-w-[calc(100vw-2rem)]" onopen={openPanel}>
		{#snippet trigger({ expanded, controls, popup, toggle, onkeydown })}
			<button type="button" class="inline-flex size-9 items-center justify-center rounded-md border border-slate-300 hover:bg-slate-100 focus-visible:outline-2" aria-label={m['organize.display']()} title={m['organize.display']()} aria-haspopup={popup} aria-expanded={expanded} aria-controls={controls} onclick={toggle} onkeydown={onkeydown}>
				<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" class="size-5">
					<path d="m9.5 3-.8 2.4-2.4 1-.1 2.5L4 10.5v3l2.2 1.6.1 2.5 2.4 1 .8 2.4h5l.8-2.4 2.4-1 .1-2.5 2.2-1.6v-3l-2.2-1.6-.1-2.5-2.4-1-.8-2.4z" />
					<circle cx="12" cy="12" r="3" />
				</svg>
			</button>
		{/snippet}
		{#snippet children()}
			<div bind:this={panel} class="space-y-4 p-4">
				<h3 class="font-semibold">{m['organize.display']()}</h3>
				<label class="grid gap-2 text-sm" for={`${id}-cover-size`}>
					<span>{m['organize.cover_size']()} <output>{size}px</output></span>
					<input id={`${id}-cover-size`} type="range" min="100" max="280" step="1" value={size} oninput={(event) => { size = Number(event.currentTarget.value); save(); }} />
				</label>
				<label class="grid gap-2 text-sm" for={`${id}-spacing`}>
					<span>{m['organize.spacing']()} <output>{spacing}px</output></span>
					<input id={`${id}-spacing`} type="range" min="0" max="48" step="2" value={spacing} oninput={(event) => { spacing = Number(event.currentTarget.value); save(); }} />
				</label>
			</div>
		{/snippet}
	</HeaderMenu>
	{#if error}<p class="text-sm text-red-700" role="alert">{error}</p>{/if}
</div>
