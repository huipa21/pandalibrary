<script lang="ts">
	import { getContext, tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { BACKGROUNDS, type BackgroundId } from '../appearance.js';
	import type { ReaderSettings } from '../types.js';
	import './toolbar.css';

	type Font = ReaderSettings['font'];
	interface Props {
		typography: boolean;
		font: Font;
		size: number;
		spacing: number;
		background: BackgroundId;
		onfont: (font: Font) => void;
		onsize: (size: number) => void;
		onspacing: (spacing: number) => void;
		onbackground: (background: BackgroundId) => void;
	}

	let { typography, font, size, spacing, background, onfont, onsize, onspacing, onbackground }: Props = $props();
	const id = $props.id();
	const nested = getContext<boolean>('pv4-menu') ?? false;
	const fonts: { value: Font; label: () => string }[] = [
		{ value: 'serif', label: m['rp2.serif'] },
		{ value: 'sans-serif', label: m['rp2.sans'] },
		{ value: 'system', label: m['rp2.system'] }
	];
	const backgroundLabels: Record<BackgroundId, () => string> = {
		white: m['rp2.white'], cream: m['rp2.cream'], sepia: m['rp2.sepia'],
		green: m['rp2.green'], wood: m['rp2.wood'], gray: m['rp2.gray'],
		blue: m['rp2.blue'], pink: m['rp2.pink'], night: m['rp2.night'], black: m['rp2.black']
	};
	const fontValues = fonts.map((option) => option.value);
	const backgroundValues = BACKGROUNDS.map((preset) => preset.id);
	const formattedSpacing = $derived(new Intl.NumberFormat(getLocale(), {
		minimumFractionDigits: 1,
		maximumFractionDigits: 1
	}).format(spacing));

	let open = $state(false);
	let root = $state<HTMLDivElement>();
	let trigger = $state<HTMLButtonElement>();
	let panel = $state<HTMLDivElement>();
	let left = $state(8);
	let top = $state(44);
	let maxHeight = $state(400);

	function placePanel(node: HTMLElement) {
		if (nested) {
			// A dialog cannot be a child of a menu; keep it inside the menu's outer host.
			const host = root?.closest('[role="menu"]')?.parentElement;
			if (!host) throw new Error('The Format overflow menu host is missing.');
			host.append(node);
		}
		return { destroy: () => node.remove() };
	}

	function contains(target: Node): boolean {
		return Boolean(root?.contains(target) || panel?.contains(target));
	}

	function onFocusOut(event: FocusEvent) {
		if (event.relatedTarget instanceof Node && !contains(event.relatedTarget)) close();
	}

	function position() {
		if (!trigger || !panel) return;
		if (!trigger.getClientRects().length) {
			open = false;
			return;
		}
		const rect = trigger.getBoundingClientRect();
		left = Math.max(8, Math.min(rect.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - 8));
		const below = Math.max(0, window.innerHeight - rect.bottom - 12);
		const above = Math.max(0, rect.top - 12);
		if (below < 100 && above > below) {
			maxHeight = above;
			top = Math.max(8, rect.top - 4 - Math.min(panel.scrollHeight, above));
		} else {
			maxHeight = below;
			top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 8));
		}
	}

	async function show() {
		open = true;
		await tick();
		if (!open) return;
		position();
		panel?.querySelector<HTMLButtonElement>('button:not([disabled]):not([tabindex="-1"])')?.focus();
	}

	function close(refocus = false) {
		open = false;
		if (refocus) trigger?.focus();
	}

	function onTriggerKey(event: KeyboardEvent) {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || (nested && event.key === 'ArrowRight')) {
			event.preventDefault();
			event.stopPropagation();
			void show();
		}
	}

	function onPanelKey(event: KeyboardEvent) {
		event.stopPropagation();
		if (event.key === 'Escape') {
			event.preventDefault();
			close(true);
		} else if (nested && event.key === 'Tab' && event.shiftKey &&
			document.activeElement === panel?.querySelector('button:not([disabled]):not([tabindex="-1"])')) {
			event.preventDefault();
			close(true);
		}
	}

	function moveRadio<T extends string>(
		event: KeyboardEvent,
		values: readonly T[],
		current: T,
		select: (value: T) => void
	) {
		const keys = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End'];
		if (!keys.includes(event.key) || !(event.currentTarget instanceof HTMLElement)) return;
		event.preventDefault();
		const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
		const focused = buttons.findIndex((button) => button === document.activeElement);
		const index = focused >= 0 ? focused : values.indexOf(current);
		const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? values.length - 1
			: (index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : values.length - 1)) % values.length;
		const next = values[nextIndex];
		if (next !== undefined) {
			select(next);
			buttons[nextIndex]?.focus();
		}
	}

	function changeSize(delta: -10 | 10) {
		onsize(Math.max(50, Math.min(200, size + delta)));
	}

	function changeSpacing(delta: -1 | 1) {
		onspacing(Math.max(10, Math.min(25, Math.round(spacing * 10) + delta)) / 10);
	}

	$effect(() => {
		if (!open) return;
		if (!nested) window.dispatchEvent(new CustomEvent('pv4-menu-open', { detail: id }));
		void tick().then(position);
		const outside = (event: PointerEvent) => {
			if (event.target instanceof Node && !contains(event.target)) close();
		};
		const other = (event: Event) => {
			if ((event as CustomEvent<string>).detail !== id && !nested) close();
		};
		document.addEventListener('pointerdown', outside);
		window.addEventListener('pv4-menu-open', other);
		window.addEventListener('resize', position);
		document.addEventListener('scroll', position, true);
		return () => {
			document.removeEventListener('pointerdown', outside);
			window.removeEventListener('pv4-menu-open', other);
			window.removeEventListener('resize', position);
			document.removeEventListener('scroll', position, true);
		};
	});
</script>

<div bind:this={root} role="group" aria-label={m['rp2.format']()} onfocusout={onFocusOut}>
	<button
		bind:this={trigger}
		type="button"
		class={nested ? 'pv4-item' : 'pv4-button rp2-trigger'}
		role={nested ? 'menuitem' : undefined}
		aria-label={m['rp2.format']()}
		title={m['rp2.format']()}
		aria-haspopup="dialog"
		aria-expanded={open}
		aria-controls={open ? `${id}-panel` : undefined}
		onclick={() => open ? close() : void show()}
		onkeydown={onTriggerKey}
	>
		{#if nested}<span class="pv4-item-label">{m['rp2.format']()}</span>
		{:else}<span class="rp2-glyph" aria-hidden="true">Aa</span>{/if}
	</button>
	{#if open}
		<div
			bind:this={panel}
			use:placePanel
			id={`${id}-panel`}
			class="pv4-panel rp2-panel"
			role="dialog"
			aria-label={m['rp2.format']()}
			tabindex="-1"
			style:left={`${left}px`}
			style:top={`${top}px`}
			style:max-height={`${maxHeight}px`}
			onkeydown={onPanelKey}
			onfocusout={onFocusOut}
			onclick={(event) => event.stopPropagation()}
		>
			{#if typography}
				<section class="rp2-section">
					<h2 id={`${id}-font`} class="rp2-label">{m['rp2.font']()}</h2>
					<div class="rp2-fonts" role="radiogroup" aria-labelledby={`${id}-font`} tabindex="-1"
						onkeydown={(event) => moveRadio(event, fontValues, font, onfont)}>
						{#each fonts as option (option.value)}
							<button type="button" class="rp2-font" role="radio" aria-checked={font === option.value}
								tabindex={font === option.value ? 0 : -1}
								onclick={() => { if (font !== option.value) onfont(option.value); }}>
								{option.label()}
							</button>
						{/each}
					</div>
				</section>
				<section class="rp2-section">
					<h2 id={`${id}-size`} class="rp2-label">{m['rp2.size']()}</h2>
					<div class="rp2-stepper" role="group" aria-labelledby={`${id}-size`}>
						<button type="button" class="rp2-step" aria-label={m['rp2.decrease_size']()}
							title={m['rp2.decrease_size']()} disabled={size <= 50} onclick={() => changeSize(-10)}>−</button>
						<output aria-live="polite" aria-label={m['rp2.size']()}>{size}%</output>
						<button type="button" class="rp2-step" aria-label={m['rp2.increase_size']()}
							title={m['rp2.increase_size']()} disabled={size >= 200} onclick={() => changeSize(10)}>+</button>
					</div>
				</section>
				<section class="rp2-section">
					<h2 id={`${id}-spacing`} class="rp2-label">{m['rp2.spacing']()}</h2>
					<div class="rp2-stepper" role="group" aria-labelledby={`${id}-spacing`}>
						<button type="button" class="rp2-step" aria-label={m['rp2.decrease_spacing']()}
							title={m['rp2.decrease_spacing']()} disabled={spacing <= 1} onclick={() => changeSpacing(-1)}>−</button>
						<output aria-live="polite" aria-label={m['rp2.spacing']()}>{formattedSpacing}</output>
						<button type="button" class="rp2-step" aria-label={m['rp2.increase_spacing']()}
							title={m['rp2.increase_spacing']()} disabled={spacing >= 2.5} onclick={() => changeSpacing(1)}>+</button>
					</div>
				</section>
			{/if}
			<section class="rp2-section">
				<h2 id={`${id}-background`} class="rp2-label">{m['rp2.background']()}</h2>
				<div class="rp2-swatches" role="radiogroup" aria-labelledby={`${id}-background`} tabindex="-1"
					onkeydown={(event) => moveRadio(event, backgroundValues, background, onbackground)}>
					{#each BACKGROUNDS as preset (preset.id)}
						<button type="button" class="rp2-swatch" role="radio"
							aria-label={backgroundLabels[preset.id]()} title={backgroundLabels[preset.id]()}
							aria-checked={background === preset.id} tabindex={background === preset.id ? 0 : -1}
							style:background-color={preset.page} style:background-image={preset.grain ?? 'none'} style:color={preset.text}
							onclick={() => { if (background !== preset.id) onbackground(preset.id); }}>
							{#if background === preset.id}<span aria-hidden="true">✓</span>{/if}
						</button>
					{/each}
				</div>
			</section>
			{#if !typography}<p class="pv4-hint rp2-hint">{m['rp2.font_hint']()}</p>{/if}
		</div>
	{/if}
</div>

<style>
	.rp2-trigger { font-size: 16px; }
	.rp2-glyph { display: inline-block; flex: none; width: 20px; font-size: 16px; font-weight: 700; text-align: center; }
	.rp2-panel { width: min(280px, calc(100vw - 16px)); padding: 14px; }
	.rp2-section + .rp2-section { margin-top: 14px; }
	.rp2-label { margin: 0 0 7px; font-size: 12px; font-weight: 600; line-height: 1.4; }
	.rp2-fonts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; padding: 3px; border-radius: 8px; background: rgb(100 116 139 / 12%); }
	.rp2-font { min-width: 0; min-height: 32px; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
	.rp2-font[aria-checked='true'] { background: rgb(16 185 129 / 20%); box-shadow: inset 0 0 0 1px #047857; }
	.rp2-stepper { display: grid; grid-template-columns: 36px 1fr 36px; align-items: center; gap: 8px; text-align: center; font-variant-numeric: tabular-nums; }
	.rp2-step { width: 36px; height: 32px; border: 0; border-radius: 6px; background: rgb(100 116 139 / 12%); color: inherit; font: inherit; font-size: 18px; cursor: pointer; }
	.rp2-step:disabled { opacity: .4; cursor: default; }
	.rp2-swatches { display: grid; grid-template-columns: repeat(5, 28px); justify-content: space-between; gap: 12px; }
	.rp2-swatch { display: grid; place-items: center; box-sizing: border-box; width: 28px; height: 28px; padding: 0; border: 1px solid rgb(100 116 139 / 55%); border-radius: 50%; font-size: 17px; font-weight: 700; line-height: 1; cursor: pointer; }
	.rp2-font:focus-visible, .rp2-step:focus-visible, .rp2-swatch:focus-visible { outline: 2px solid #10b981; outline-offset: 2px; }
	.rp2-hint { margin: 12px 0 0; }
</style>
