<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { tick, type Snippet } from 'svelte';

	interface TriggerProps {
		expanded: boolean;
		controls: string;
		popup: 'menu' | 'dialog';
		toggle: () => void;
		onkeydown: (event: KeyboardEvent) => void;
	}

	interface Props {
		menuId: string;
		popup: 'menu' | 'dialog';
		label: string;
		panelClass?: string;
		onopen?: () => void;
		trigger: Snippet<[TriggerProps]>;
		children: Snippet<[() => void]>;
	}

	let { menuId, popup, label, panelClass = '', onopen, trigger, children }: Props = $props();
	let open = $state(false);
	let root = $state<HTMLDivElement | null>(null);
	const panelId = $derived(`${menuId}-panel`);

	function focusTarget(selector: string) {
		root?.querySelector<HTMLElement>(selector)?.focus();
	}

	async function setOpen(next: boolean, returnFocus = false) {
		if (open === next) return;
		open = next;
		if (next) {
			window.dispatchEvent(new CustomEvent('pandalibrary:header-menu-open', { detail: menuId }));
			await tick();
			if (popup === 'menu') focusTarget('[role="menuitem"]');
			else onopen?.();
		} else if (returnFocus) {
			await tick();
			focusTarget('button');
		}
	}

	function close(returnFocus = false) {
		void setOpen(false, returnFocus);
	}

	function toggle() {
		void setOpen(!open);
	}

	function onOtherMenu(event: Event) {
		if ((event as CustomEvent<string>).detail !== menuId) close();
	}

	function onDocumentPointerDown(event: PointerEvent) {
		if (open && !root?.contains(event.target as Node)) close();
	}

	function onFocusOut(event: FocusEvent) {
		if (open && !root?.contains(event.relatedTarget as Node | null)) close();
	}

	function onKeyDown(event: KeyboardEvent) {
		if (!open) {
			if (event.target === root?.querySelector('button') && event.key === 'ArrowDown') {
				event.preventDefault();
				void setOpen(true);
			}
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			close(true);
			return;
		}

		const options = [...(root?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="option"]') ?? [])];
		const active = document.activeElement;
		const index = options.indexOf(active as HTMLElement);
		if (event.key === 'ArrowDown' && (popup === 'menu' || active?.matches('[role="option"], input'))) {
			event.preventDefault();
			options[(index + 1 + options.length) % options.length]?.focus();
		} else if (event.key === 'ArrowUp' && index >= 0) {
			event.preventDefault();
			options[(index - 1 + options.length) % options.length]?.focus();
		} else if (event.key === 'Home' && index >= 0) {
			event.preventDefault();
			options[0]?.focus();
		} else if (event.key === 'End' && index >= 0) {
			event.preventDefault();
			options.at(-1)?.focus();
		}
	}

	function onPanelClick(event: MouseEvent) {
		if ((event.target as Element).closest('[data-menu-activate]')) close(true);
	}

	$effect(() => {
		if (!open) return;
		const handleOpen = (event: Event) => onOtherMenu(event);
		window.addEventListener('pandalibrary:header-menu-open', handleOpen);
		return () => window.removeEventListener('pandalibrary:header-menu-open', handleOpen);
	});

	afterNavigate(({ from }) => {
		if (from) close();
	});
</script>

<svelte:document onpointerdown={onDocumentPointerDown} />

<div bind:this={root} class="header-menu" role="group" aria-label={label} onfocusout={onFocusOut}>
	{@render trigger({ expanded: open, controls: panelId, popup, toggle, onkeydown: onKeyDown })}
	{#if open}
		<div
			id={panelId}
			class={`header-menu-panel ${panelClass}`}
			role={popup === 'menu' ? 'menu' : 'dialog'}
			aria-label={label}
			onclick={onPanelClick}
			onkeydown={onKeyDown}
		>
			{@render children(() => close(true))}
		</div>
	{/if}
</div>
