<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import NoteEditor from '../../NoteEditor.svelte';
	import { floatAt } from './float-at.js';
	import type { RectLike } from './floating.js';

	let { anchor, bounds, initial, disabled = false, onsave, oncancel }: {
		anchor: RectLike;
		bounds: RectLike;
		initial: string;
		disabled?: boolean;
		onsave: (body: string) => void;
		oncancel: (body: string) => void;
	} = $props();

	// svelte-ignore state_referenced_locally: the editor owns the text after it opens.
	let body = $state(initial);
	let element = $state<HTMLDivElement>();

	onMount(() => {
		// CodeMirror mounts lazily; focus its content once it is there.
		const timer = setInterval(() => {
			const editor = element?.querySelector<HTMLElement>('.cm-content');
			if (!editor) return;
			clearInterval(timer);
			editor.focus({ preventScroll: true });
		}, 30);
		return () => clearInterval(timer);
	});

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			oncancel(body);
		} else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && body.trim()) {
			event.preventDefault();
			onsave(body);
		}
	}
</script>

<div
	bind:this={element}
	use:floatAt={{ anchor, bounds }}
	class="pv8-floating pv8-comment"
	role="dialog"
	tabindex="-1"
	aria-label={initial ? m['pv8.edit_comment']() : m['pv8.add_comment']()}
	data-testid="pv8-comment"
	{onkeydown}
>
	<NoteEditor value={body} onChange={(value) => { body = value; }} />
	<div class="pv8-comment-actions">
		<button type="button" class="pv8-text-button" onclick={() => oncancel(body)}>{m['reader.note.cancel']()}</button>
		<button type="button" class="pv8-text-button pv8-primary" disabled={disabled || !body.trim()} onclick={() => onsave(body)}>{m['reader.note.save']()}</button>
	</div>
</div>
