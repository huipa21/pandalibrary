<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { focusableWithin, nextTrappedFocus } from '#lib/shell/focus.js';

	let { initial, disabled = false, onsave, oncancel, onchange }: {
		initial: string;
		disabled?: boolean;
		onsave: (body: string) => void;
		oncancel: (body: string) => void;
		onchange?: (body: string) => void;
	} = $props();
	// svelte-ignore state_referenced_locally
	let body = $state(initial);
	let textarea: HTMLTextAreaElement;
	let root: HTMLDivElement;

	onMount(() => textarea.focus({ preventScroll: true }));

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			if (!disabled) oncancel(body);
		} else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			event.stopPropagation();
			if (!disabled && body.trim()) onsave(body);
		} else if (event.key === 'Tab') {
			const next = nextTrappedFocus(focusableWithin(root), document.activeElement, event.shiftKey);
			if (next) { event.preventDefault(); next.focus(); }
		}
	}
</script>

<div bind:this={root} class="sticky-note" role="dialog" tabindex="-1" aria-label={initial ? m['pv8.edit_comment']() : m['pv8.add_comment']()} {onkeydown}>
	<textarea
		bind:this={textarea}
		bind:value={body}
		aria-label={m['pv8.comment']()}
		readonly={disabled}
		oninput={(event) => onchange?.(event.currentTarget.value)}
	></textarea>
	<div class="sticky-note-actions">
		<button type="button" {disabled} onclick={() => oncancel(body)}>{m['reader.note.cancel']()}</button>
		<button type="button" class="save" disabled={disabled || !body.trim()} onclick={() => onsave(body)}>{m['reader.note.save']()}</button>
	</div>
</div>

<style>
	.sticky-note {
		box-sizing: border-box;
		width: min(22rem, calc(100vw - 32px));
		max-width: 100%;
		padding: 16px;
		border: 1px solid #dfcf7b;
		border-radius: 2px 2px 14px 2px;
		background: #fff3af;
		color: #493d1b;
		box-shadow: 0 8px 22px rgb(0 0 0 / 18%);
		font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
	}
	textarea {
		box-sizing: border-box;
		display: block;
		width: 100%;
		min-height: 9rem;
		max-height: 50vh;
		padding: 8px;
		resize: vertical;
		border: 1px solid transparent;
		border-radius: 2px;
		background: transparent;
		color: inherit;
		font: inherit;
	}
	textarea:focus-visible { outline: 2px solid #8a7026; outline-offset: 1px; }
	.sticky-note-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
	button { min-height: 32px; padding: 4px 12px; border: 1px solid #bba757; border-radius: 4px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
	button.save { background: #66551d; color: #fffdf3; border-color: #66551d; }
	button:focus-visible { outline: 2px solid #8a7026; outline-offset: 2px; }
	button:disabled { opacity: 0.5; cursor: default; }
</style>
