<script lang="ts">
	import { getContext, setContext, tick, type Snippet } from 'svelte';
	import Icon, { type IconName } from '#lib/bookview/Icon.svelte';
	import { focusableWithin } from '#lib/shell/focus.js';
	import './toolbar.css';

	interface Props {
		label: string;
		triggerLabel?: string;
		icon?: IconName;
		text?: string;
		open?: boolean;
		disabled?: boolean;
		children: Snippet;
		align?: 'start' | 'end';
	}

	let { label, triggerLabel, icon, text, open = $bindable(false), disabled = false, children, align = 'end' }: Props = $props();
	const id = $props.id();
	const nested = getContext<boolean>('pv4-menu') ?? false;
	setContext('pv4-menu', true);
	let root = $state<HTMLDivElement>();
	let trigger = $state<HTMLButtonElement>();
	let panel = $state<HTMLDivElement>();
	let left = $state(8);
	let top = $state(44);
	let maxHeight = $state(400);

	function items() {
		return focusableWithin(panel ?? null).filter((item) => item.closest('[role="menu"]') === panel);
	}

	function position() {
		if (!trigger || !panel) return;
		if (!trigger.getClientRects().length) {
			open = false;
			return;
		}
		const rect = trigger.getBoundingClientRect();
		top = Math.min(rect.bottom + 4, window.innerHeight - 8);
		left = Math.max(8, Math.min(
			align === 'start' ? rect.left : rect.right - panel.offsetWidth,
			window.innerWidth - panel.offsetWidth - 8
		));
		maxHeight = Math.max(0, window.innerHeight - top - 8);
	}

	async function show(last = false) {
		if (disabled) return;
		open = true;
		await tick();
		if (!open || disabled) return;
		(last ? items().at(-1) : items()[0])?.focus();
	}

	function close(refocus = false) {
		open = false;
		if (refocus) trigger?.focus();
	}

	function onTriggerKey(event: KeyboardEvent) {
		if (['ArrowDown', 'ArrowUp', 'Enter', ' ', ...(nested ? ['ArrowRight'] : [])].includes(event.key)) {
			event.preventDefault();
			event.stopPropagation();
			void show(event.key === 'ArrowUp');
		}
	}

	function onPanelKey(event: KeyboardEvent) {
		if (event.key === 'Tab') {
			// Restore triggers before native Tab so nested menus leave in document order.
			close(true);
			return;
		}
		if (!(event.target instanceof Element) || event.target.closest('[role="menu"]') !== panel) return;
		if (event.key === 'Escape' || (nested && event.key === 'ArrowLeft')) {
			event.preventDefault();
			event.stopPropagation();
			close(true);
		} else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
			event.preventDefault();
			event.stopPropagation();
			const options = items();
			const index = options.findIndex((item) => item === document.activeElement);
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
				: (index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
			options[next]?.focus();
		}
	}

	function onPanelClick(event: MouseEvent) {
		if (!(event.target instanceof Element)) return;
		const item = event.target.closest<HTMLButtonElement>('button');
		if (item && !item.disabled && !item.hasAttribute('aria-haspopup') && !item.hasAttribute('data-pv4-keep-open')) close(true);
	}

	$effect(() => {
		if (disabled) {
			open = false;
			return;
		}
		if (!open) return;
		if (!nested) window.dispatchEvent(new CustomEvent('pv4-menu-open', { detail: id }));
		void tick().then(() => {
			position();
			if (open && panel && !panel.contains(document.activeElement)) items()[0]?.focus();
		});
		const outside = (event: PointerEvent) => {
			if (event.target instanceof Node && !root?.contains(event.target)) close();
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

<div bind:this={root} role="group" aria-label={label} onfocusout={(event) => {
	if (event.relatedTarget instanceof Node && !root?.contains(event.relatedTarget)) close();
}}>
	<button
		bind:this={trigger}
		type="button"
		{disabled}
		class={nested ? 'pv4-item' : `pv4-button ${text ? 'pv4-text-button' : ''}`}
		role={nested ? 'menuitem' : undefined}
		aria-label={triggerLabel ?? label}
		title={label}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-controls={open ? `${id}-panel` : undefined}
		onclick={() => open ? close() : void show()}
		onkeydown={onTriggerKey}
	>
		{#if icon}<Icon name={icon} />{/if}
		{#if nested}<span class="pv4-item-label">{label}{text ? ` (${text})` : ''}</span>
		{:else if text}<span>{text}</span>{/if}
		{#if text || nested}<Icon name={nested ? 'chevron-right' : 'chevron-down'} class="size-3" />{/if}
	</button>
	{#if open}
		<div
			bind:this={panel}
			id={`${id}-panel`}
			class="pv4-panel"
			role="menu"
			tabindex="-1"
			aria-label={label}
			style:left={`${left}px`}
			style:top={`${top}px`}
			style:max-height={`${maxHeight}px`}
			onkeydown={onPanelKey}
			onclick={onPanelClick}
		>
			{@render children()}
		</div>
	{/if}
</div>
