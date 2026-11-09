<script lang="ts">
	import { onMount } from 'svelte';
	import type { EditorView as EditorViewType } from '@codemirror/view';
	import * as m from '#lib/paraglide/messages.js';
	import { renderMarkdown } from './markdown.js';

	let { value, onChange }: { value: string; onChange: (value: string) => void } = $props();
	let editorElement: HTMLDivElement;
	const preview = $derived(renderMarkdown(value));

	onMount(() => {
		let view: EditorViewType | undefined;
		let destroyed = false;
		void initEditor().then((created) => {
			if (destroyed) created.destroy();
			else view = created;
		});
		return () => {
			destroyed = true;
			view?.destroy();
		};
	});

	// CodeMirror is loaded lazily to keep it out of the reader page's initial chunk.
	async function initEditor() {
		const [{ EditorState }, { EditorView, keymap }, { defaultKeymap, history, historyKeymap }, { markdown }] =
			await Promise.all([
				import('@codemirror/state'),
				import('@codemirror/view'),
				import('@codemirror/commands'),
				import('@codemirror/lang-markdown')
			]);
		return new EditorView({
			parent: editorElement,
			state: EditorState.create({
				doc: value,
				extensions: [
					history(),
					markdown(),
					keymap.of([...defaultKeymap, ...historyKeymap]),
					EditorView.lineWrapping,
					EditorView.contentAttributes.of({
						'aria-label': m['reader.note.markdown'](),
						'aria-multiline': 'true',
						role: 'textbox'
					}),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) onChange(update.state.doc.toString());
					})
				]
			})
		});
	}
</script>

<div class="grid gap-4 md:grid-cols-2">
	<div>
		<p class="mb-2 text-sm font-medium">{m['reader.note.markdown']()}</p>
		<div class="reader-note-editor rounded-md border border-slate-300 bg-white" bind:this={editorElement}></div>
	</div>
	<div>
		<h4 class="mb-2 text-sm font-medium">{m['reader.note.preview']()}</h4>
		<div class="reader-note-preview min-h-32 overflow-auto rounded-md border border-slate-200 bg-white p-3 text-sm">
			{#if value.trim()}
				{@html preview}
			{:else}
				<p class="text-slate-500">{m['reader.note.empty_preview']()}</p>
			{/if}
		</div>
	</div>
</div>

<style>
	.reader-note-editor,
	.reader-note-preview {
		color: #0f172a;
	}

	.reader-note-editor :global(.cm-editor) {
		min-height: 8rem;
	}

	.reader-note-editor :global(.cm-editor.cm-focused) {
		outline: 2px solid #0f172a;
		outline-offset: 2px;
	}

	.reader-note-preview :global(p),
	.reader-note-preview :global(ul),
	.reader-note-preview :global(ol),
	.reader-note-preview :global(pre) {
		margin-block: 0.5rem;
	}

	.reader-note-preview :global(a) {
		color: #1d4ed8;
		text-decoration: underline;
	}
</style>
