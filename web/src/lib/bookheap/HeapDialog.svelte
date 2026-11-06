<script lang="ts">
	import type { Snippet } from 'svelte';
	import { focusableWithin, nextTrappedFocus } from '#lib/shell/focus.js';

	interface Props {
		open: boolean;
		/** Unique ID prefix for the title and description elements. */
		id: string;
		title: string;
		/** While true, Escape does not close the dialog. */
		busy?: boolean;
		onclose: () => void;
		/** CSS selector of the element focused on open; defaults to the first focusable element. */
		initialFocus?: string;
		children: Snippet;
	}

	let { open, id, title, busy = false, onclose, initialFocus, children }: Props = $props();
	let dialogElement = $state<HTMLDialogElement | null>(null);

	$effect(() => {
		if (!open || !dialogElement) return;
		const dialog = dialogElement;
		const originalFocusElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialog.showModal();
		const preferred = initialFocus ? dialog.querySelector<HTMLElement>(initialFocus) : null;
		(preferred ?? focusableWithin(dialog)[0])?.focus();
		return () => {
			if (dialog.open) dialog.close();
			if (originalFocusElement?.isConnected) originalFocusElement.focus();
		};
	});

	function cancel(event: Event) {
		event.preventDefault();
		if (!busy) onclose();
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Tab') return;
		const target = nextTrappedFocus(focusableWithin(dialogElement), document.activeElement, event.shiftKey);
		if (target) {
			event.preventDefault();
			target.focus();
		}
	}
</script>

{#if open}
	<dialog
		bind:this={dialogElement}
		class="fixed inset-0 m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-lg bg-white p-6 text-slate-950 shadow-lg"
		aria-labelledby={`${id}-title`}
		oncancel={cancel}
		{onkeydown}
	>
		<h2 id={`${id}-title`} class="text-lg font-semibold">{title}</h2>
		{@render children()}
	</dialog>
{/if}

<style>
	dialog::backdrop {
		background: rgb(15 23 42 / 0.6);
	}
</style>
