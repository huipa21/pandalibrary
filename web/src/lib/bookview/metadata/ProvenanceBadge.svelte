<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { MergeField } from '#lib/metadata/types.js';
	import type { MetadataEditorState } from './editor-state.svelte.js';
	import { fieldSource, sourceLabel } from './labels.js';

	let { editor, field }: { editor: MetadataEditorState; field: MergeField } = $props();

	const selected = $derived(editor.selections[field]);
	const saved = $derived(fieldSource(editor.book, field));
</script>

{#if selected}
	<span class="provenance pending" data-provenance="pending" title={m['metadata.source.pending']({ provider: selected.provider })}>
		→ {selected.provider}
	</span>
{:else if saved}
	<span class="provenance" data-provenance={saved.source} title={m['metadata.source.label']({ source: sourceLabel(saved.source) })}>
		{sourceLabel(saved.source)}
	</span>
{/if}

<style>
	.provenance {
		display: inline-flex;
		max-width: 10rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		border: 1px solid #cbd5e1;
		border-radius: 999px;
		padding: 0 0.4rem;
		font-size: 0.6875rem;
		line-height: 1.125rem;
		color: #475569;
		background: #f8fafc;
	}
	.pending { border-color: #059669; color: #065f46; background: #ecfdf5; }
</style>
