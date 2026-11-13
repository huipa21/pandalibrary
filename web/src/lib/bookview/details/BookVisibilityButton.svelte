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
	const currentVisibility = $derived(book.visibility === 'library'
		? m['bv.visibility.library']()
		: makePublic ? m['bv.visibility.private']() : m['bh.visibility.public']());
	const actionLabel = $derived(makePublic ? m['bv.visibility.make_public']() : m['bv.visibility.make_private']());
	const label = $derived(book.can_manage_visibility ? actionLabel : m['bv.visibility.view_only']({ state: currentVisibility }));
	const description = $derived(makePublic ? m['bv.visibility.public_description']() : m['bv.visibility.private_description']());
	const disabledReason = $derived(!book.can_manage_visibility
		? book.owner_id === null ? m['bv.visibility.admin_only']() : m['bv.visibility.owner_only']()
		: disconnected ? m['bv.visibility.offline']() : '');

	onDestroy(() => controller?.abort());

	async function toggle() {
		if (!book.can_manage_visibility || disconnected || busy) return;
		const visibility = makePublic ? 'public' : 'private';
		let confirmation: string = makePublic
			? m['bv.visibility.confirm_public']({ title: book.title })
			: m['bv.visibility.confirm_private']({ title: book.title });
		if (book.owner_id === null) {
			confirmation += `\n\n${book.visibility === 'library' ? m['bv.visibility.claim_library']() : m['bv.visibility.claim_owner']()}`;
		}
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

<button
	type="button"
	class="shell-icon-button size-10 disabled:opacity-60"
	aria-label={label}
	aria-describedby={`${id}-state${disabledReason ? ` ${id}-reason` : ''}`}
	title={disabledReason ? `${currentVisibility}: ${disabledReason}` : `${currentVisibility}; ${actionLabel}: ${description}`}
	disabled={!book.can_manage_visibility || disconnected || busy}
	aria-busy={busy}
	onclick={() => void toggle()}
>
	<Icon name={busy ? 'refresh' : makePublic ? 'eye-off' : 'eye'} class={busy ? 'size-5 shrink-0 animate-spin motion-reduce:animate-none' : 'size-5 shrink-0'} />
</button>
<span id={`${id}-state`} class="sr-only">{currentVisibility}</span>
{#if disabledReason}
	<span id={`${id}-reason`} class={disconnected && book.can_manage_visibility ? 'basis-full text-xs text-slate-500' : 'sr-only'}>{disabledReason}</span>
{/if}
{#if error}<p class="basis-full text-sm text-red-800" role="alert">{error}</p>{/if}
{#if notice}<p class="sr-only" role="status">{notice}</p>{/if}
