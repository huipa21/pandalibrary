<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { MetadataEditorState } from './editor-state.svelte.js';

	let { editor }: { editor: MetadataEditorState } = $props();
</script>

{#if editor.saveError}<p class="rounded-md bg-red-50 p-3 text-red-800" role="alert">{editor.saveError}</p>{/if}
{#if editor.recoveryBlocked}
	<button type="button" class="secondary-button" disabled={editor.saving || editor.recovering}
		onclick={() => editor.recoverFromConflict()}>{m['metadata.save.retry_recovery']()}</button>
{/if}
<div class="save-controls">
	<button type="submit" class="primary-button" disabled={editor.busy || editor.lookupPending || !editor.dirty}>
		{editor.saving ? m['metadata.save.saving']() : m['metadata.save.submit']()}
	</button>
	<button type="button" class="secondary-button" disabled={editor.busy || !editor.dirty} onclick={() => editor.restoreAll()}>
		{m['metadata.restore_all']()}
	</button>
</div>

<style>
	.save-controls {
		position: sticky; bottom: 0; z-index: 1;
		display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1rem;
		border-top: 1px solid #e2e8f0; padding: 0.75rem 0; background: white;
	}
	.primary-button, .secondary-button { border-radius: 0.375rem; padding: 0.5rem 0.75rem; font-size: 0.875rem; font-weight: 500; }
	.primary-button { background: #0f172a; color: white; }
	.secondary-button { border: 1px solid #cbd5e1; }
	button:focus-visible { outline: 2px solid #334155; outline-offset: 2px; }
	button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
