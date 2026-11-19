<script lang="ts">
	import { showLoadingAfterDelay } from '#lib/ui/deferred.js';
	import * as m from '#lib/paraglide/messages.js';
	import HeapDialog from '#lib/bookheap/HeapDialog.svelte';
	import { deleteLibrary, listAllAdminLibraries } from '#lib/admin/api.js';
	import { adminErrorKey } from '#lib/admin/form.js';
	import { dangerButton, secondaryButton, inputClass, errorBox, warningBox } from '#lib/admin/ui.js';
	import type { Library } from '#lib/catalog/types.js';
	import { translate } from '#lib/paging/translate.js';

	let { library, onclose, ondeleted }: {
		library: Library | null;
		onclose: () => void;
		ondeleted: (library: Library) => void | Promise<void>;
	} = $props();

	let targets = $state<Library[]>([]);
	let destination = $state('');
	let loading = $state(true);
	let busy = $state(false);
	let error = $state('');
	let loaded = $state(false);

	$effect(() => {
		if (!library) return;
		const current = library;
		const controller = new AbortController();
		destination = '';
		targets = [];
		error = '';
		loaded = false;
		loading = true;
		void listAllAdminLibraries(controller.signal).then((libraries) => {
			if (controller.signal.aborted) return;
			targets = libraries.filter((item) => item.id !== current.id);
			loaded = true;
		}).catch((cause) => {
			if (!controller.signal.aborted) error = translate(adminErrorKey(cause, 'load'));
		}).finally(() => {
			if (!controller.signal.aborted) loading = false;
		});
		return () => controller.abort();
	});

	async function remove(event: SubmitEvent) {
		event.preventDefault();
		if (!library || busy || !loaded || !targets.some((item) => String(item.id) === destination)) return;
		const current = library;
		busy = true;
		error = '';
		try {
			await deleteLibrary(current.id, Number(destination));
			window.dispatchEvent(new CustomEvent('pandalibrary-libraries-changed'));
			await ondeleted(current);
			onclose();
		} catch (cause) {
			error = translate(adminErrorKey(cause, 'delete_library'));
		} finally {
			busy = false;
		}
	}
</script>

<HeapDialog open={library !== null} id="library-delete" title={m['admin.libraries.delete']()} {busy}
	{onclose} initialFocus="#library-delete-cancel">
	<p class="mt-4">{m['admin.libraries.delete_confirm']({ name: library?.name ?? '' })}</p>
	{#if loading}
		<p use:showLoadingAfterDelay class="mt-4" role="status">{m['catalog.loading']()}</p>
	{:else if loaded && targets.length === 0}
		<p class={`mt-4 ${warningBox}`} role="alert">{m['admin.libraries.delete_last']()}</p>
	{:else if loaded}
		<p class={`mt-4 ${warningBox}`}>{m['admin.libraries.delete_transfer_warning']()}</p>
	{/if}
	{#if error}<p class={`mt-4 ${errorBox}`} role="alert">{error}</p>{/if}
	<form class="mt-4 space-y-4" onsubmit={remove}>
		{#if loaded && targets.length > 0}
			<label class="grid gap-1 text-sm font-medium" for="library-delete-destination">
				<span>{m['admin.libraries.delete_destination']()}</span>
				<select id="library-delete-destination" class={inputClass} bind:value={destination} required disabled={busy}>
					<option value="">{m['bh4.assign.library_choose']()}</option>
					{#each targets as target (target.id)}<option value={String(target.id)}>{target.name}</option>{/each}
				</select>
			</label>
		{/if}
		<div class="flex justify-end gap-3">
			<button id="library-delete-cancel" type="button" class={secondaryButton} disabled={busy} onclick={onclose}>{m['admin.cancel']()}</button>
			<button type="submit" class={dangerButton} disabled={busy || loading || !loaded || !destination}>
				{busy ? m['admin.libraries.deleting']() : m['admin.libraries.delete']()}
			</button>
		</div>
	</form>
</HeapDialog>
