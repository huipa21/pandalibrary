<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { Book } from '#lib/catalog/types.js';
	import * as m from '#lib/paraglide/messages.js';
	import { currentAccount, offlineStatus } from '#lib/sync/client.js';
	import Icon from '../Icon.svelte';
	import { setBookVisibility } from './visibility-api.js';

	let { book, offline, onUpdate }: {
		book: Book;
		offline: boolean;
		onUpdate: (book: Book) => void;
	} = $props();
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');
	let controller: AbortController | null = null;
	const id = $props.id();
	const disconnected = $derived(offline || !$offlineStatus.online);
	const makePublic = $derived(book.visibility === 'private');
	const currentVisibility = $derived(makePublic ? m['bh.visibility.private']() : m['bh.visibility.public']());
	const label = $derived(makePublic ? m['bv.visibility.make_public']() : m['bv.visibility.make_private']());
	const description = $derived(makePublic ? m['bv.visibility.public_description']() : m['bv.visibility.private_description']());

	onDestroy(() => controller?.abort());

	async function toggle() {
		if (!book.can_manage_visibility || disconnected || busy) return;
		const visibility = makePublic ? 'public' : 'private';
		const confirmation = makePublic
			? m['bv.visibility.confirm_public']({ title: book.title })
			: m['bv.visibility.confirm_private']({ title: book.title });
		if (!window.confirm(confirmation)) return;
		const bookId = book.id;
		const account = currentAccount();
		controller = new AbortController();
		const signal = controller.signal;
		busy = true;
		error = '';
		notice = '';
		try {
			const updated = await setBookVisibility(bookId, visibility, signal);
			if (signal.aborted || book.id !== bookId || currentAccount() !== account) return;
			onUpdate(updated);
			notice = visibility === 'public' ? m['bv.visibility.saved_public']() : m['bv.visibility.saved_private']();
		} catch (cause) {
			if (signal.aborted || book.id !== bookId || currentAccount() !== account) return;
			console.error('Could not update book visibility', cause);
			error = m['bv.visibility.error']();
		} finally {
			busy = false;
		}
	}
</script>

{#if book.can_manage_visibility}
	<div class="w-full min-w-0">
		<button
			type="button"
			class="inline-flex w-full min-w-0 items-center gap-3 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-left text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-60"
			aria-label={label}
			aria-describedby={`${id}-state${disconnected ? ` ${id}-offline` : ''}`}
			title={disconnected ? m['bv.visibility.offline']() : `${label}: ${description}`}
			disabled={disconnected || busy}
			aria-busy={busy}
			onclick={() => void toggle()}
		>
			<Icon name={busy ? 'refresh' : makePublic ? 'lock' : 'globe'} class={busy ? 'size-5 shrink-0 animate-spin motion-reduce:animate-none' : 'size-5 shrink-0'} />
			<span class="min-w-0">
				<span id={`${id}-state`} class="block text-xs">{currentVisibility}</span>
				<span class="block text-sm font-semibold">{label}</span>
			</span>
		</button>
		{#if disconnected}<p id={`${id}-offline`} class="mt-2 text-xs text-slate-500">{m['bv.visibility.offline']()}</p>{/if}
		{#if error}<p class="mt-2 text-sm text-red-800" role="alert">{error}</p>{/if}
		{#if notice}<p class="sr-only" role="status">{notice}</p>{/if}
	</div>
{/if}
