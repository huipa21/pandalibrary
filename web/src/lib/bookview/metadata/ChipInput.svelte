<script lang="ts">
	import type { MetadataEditorState, TermField } from './editor-state.svelte.js';

	let { editor, field, newLabel, addLabel, removeLabel, emptyLabel, removeText }: {
		editor: MetadataEditorState;
		field: TermField;
		newLabel: string;
		addLabel: string;
		removeLabel: (name: string) => string;
		emptyLabel: string;
		removeText: string;
	} = $props();

	const inputId = $derived(`metadata-new-${field}`);
</script>

<ul class="chips">
	{#each editor.draft[field] as name, index (index)}
		<li class="chip">
			<span class="chip-name">{name}</span>
			<button type="button" class="chip-remove" aria-label={removeLabel(name)} title={removeText}
				onclick={() => editor.removeTerm(field, index)}>×</button>
		</li>
	{/each}
</ul>
{#if !editor.draft[field].length}<p class="text-sm text-slate-500">{emptyLabel}</p>{/if}
<div class="chip-entry">
	<label class="sr-only" for={inputId}>{newLabel}</label>
	<input id={inputId} placeholder={newLabel} bind:value={editor.pending[field]} oninput={() => editor.edited(field)}
		onkeydown={(event) => { if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); editor.addTerm(field); } }} />
	<button type="button" class="secondary-button" onclick={() => editor.addTerm(field)}>{addLabel}</button>
</div>

<style>
	.chips { display: flex; flex-wrap: wrap; gap: 0.375rem; min-width: 0; }
	.chips:empty { display: none; }
	.chip {
		display: inline-flex; align-items: center; gap: 0.25rem; max-width: 100%;
		border-radius: 999px; background: #e2e8f0; padding: 0.125rem 0.25rem 0.125rem 0.625rem; font-size: 0.8125rem;
	}
	.chip-name { overflow-wrap: anywhere; }
	.chip-remove {
		display: inline-flex; align-items: center; justify-content: center; width: 1.5rem; height: 1.5rem;
		border-radius: 999px; font-size: 1rem; line-height: 1;
	}
	.chip-remove:hover { background: #cbd5e1; }
	.secondary-button { border: 1px solid #cbd5e1; border-radius: 0.375rem; padding: 0.375rem 0.75rem; font-size: 0.875rem; font-weight: 500; white-space: nowrap; }
	button:focus-visible, input:focus-visible { outline: 2px solid #334155; outline-offset: 2px; }
	input { width: 100%; border: 1px solid #cbd5e1; border-radius: 0.375rem; padding: 0.375rem 0.625rem; }
	.chip-entry { display: flex; gap: 0.5rem; min-width: 0; margin-top: 0.375rem; }
	.chip-entry input { flex: 1; min-width: 4rem; }
</style>
