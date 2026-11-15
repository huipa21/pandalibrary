<script lang="ts">
	import { untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import CoverEditor from '#lib/bookview/CoverEditor.svelte';
	import { coverCloth, randomCoverColor } from '#lib/bookview/cover.js';
	import { focusableWithin, nextTrappedFocus } from '#lib/shell/focus.js';
	import type { Wordbook, WordbookOptions } from './api.js';

	let { mode, book, onclose, onsave, ondelete, canDelete = true }: {
		mode: 'new' | 'rename';
		book?: Wordbook;
		onclose: () => void;
		onsave: (name: string, options: WordbookOptions) => Promise<void>;
		ondelete?: () => void;
		canDelete?: boolean;
	} = $props();
	let dialog = $state<HTMLDialogElement | null>(null);
	let name = $state(untrack(() => mode === 'rename' ? book?.name ?? '' : ''));
	let description = $state(untrack(() => mode === 'rename' ? book?.description ?? '' : ''));
	let language = $state(untrack(() => mode === 'rename' ? book?.language ?? '' : ''));
	let meaningLanguage = $state(untrack(() => mode === 'rename' ? book?.meaning_language ?? '' : ''));
	let color = $state(untrack(() => mode === 'rename' ? book?.cover_color || coverCloth(book?.id ?? 0).name : randomCoverColor()));
	let image = $state(untrack(() => mode === 'rename' ? book?.cover_image ?? '' : ''));
	let submitting = $state(false);
	let coverBusy = $state(false);
	let error = $state('');
	const busy = $derived(submitting || coverBusy);
	const label = $derived(mode === 'new' ? m['wordbooks.new']() : m['wordbooks.settings']());
	function languageName(value: string): string {
		const base = value.toLowerCase().split('-')[0];
		return base === 'en' ? m['dict.lang.en']() : base === 'zh' ? m['dict.lang.zh']() : base === 'ja' ? m['dict.lang.ja']() : value;
	}
	function meaningLabel(target: string): string {
		return language ? m['wordbooks.languagePair']({ source: languageName(language), target: languageName(target) }) : languageName(target);
	}

	$effect(() => {
		if (!dialog) return;
		const element = dialog;
		const originalFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		element.showModal();
		element.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
		return () => {
			if (element.open) element.close();
			if (originalFocus?.isConnected) originalFocus.focus();
		};
	});

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (busy || !name.trim()) return;
		submitting = true;
		error = '';
		try {
			await onsave(name.trim(), { description: description.trim(), cover_color: color, cover_image: image, language, meaning_language: meaningLanguage });
			onclose();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			submitting = false;
		}
	}

	function cancel(event?: Event) {
		event?.preventDefault();
		if (!submitting) onclose();
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Tab') return;
		const target = nextTrappedFocus(focusableWithin(dialog), document.activeElement, event.shiftKey);
		if (target) { event.preventDefault(); target.focus(); }
	}
</script>

<dialog bind:this={dialog} class="fixed inset-0 m-auto max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-6 text-slate-950 shadow-lg" aria-label={label} aria-busy={busy} oncancel={cancel} {onkeydown}>
	<h2 class="mb-4 text-lg font-semibold">{label}</h2>
	<form class="space-y-4" aria-label={label} onsubmit={save}>
		<label class="grid gap-2"><span class="text-sm font-medium">{m['wordbooks.name']()}</span><input class="field" name="name" required maxlength="200" bind:value={name} disabled={submitting} /></label>
			<label class="grid gap-2"><span class="text-sm font-medium">{m['wordbooks.language']()}</span><select class="field" name="language" aria-label={m['wordbooks.language']()} bind:value={language} disabled={submitting}>
				<option value="">{m['wordbooks.languageUnspecified']()}</option>
				<option value="en">{m['dict.lang.en']()}</option>
				<option value="zh">{m['dict.lang.zh']()}</option>
				<option value="ja">{m['dict.lang.ja']()}</option>
				{#if language && !['en', 'zh', 'ja'].includes(language)}<option value={language}>{language}</option>{/if}
			</select></label>
		<label class="grid gap-2"><span class="text-sm font-medium">{m['wordbooks.meaningLanguage']()}</span><select class="field" name="meaning_language" aria-label={m['wordbooks.meaningLanguage']()} bind:value={meaningLanguage} disabled={submitting}>
			<option value="">{m['wordbooks.languageUnspecified']()}</option>
			{#each ['en', 'zh', 'ja'] as target}<option value={target}>{meaningLabel(target)}</option>{/each}
			{#if meaningLanguage && !['en', 'zh', 'ja'].includes(meaningLanguage)}<option value={meaningLanguage}>{meaningLabel(meaningLanguage)}</option>{/if}
		</select></label>
		<label class="grid gap-2"><span class="text-sm font-medium">{m['wordbooks.description']()}</span><textarea class="field" rows="2" maxlength="2000" bind:value={description} disabled={submitting}></textarea></label>
		<CoverEditor title={name} seed={mode === 'rename' ? book?.id ?? 0 : 0} bind:color bind:image disabled={submitting} onbusy={(value) => coverBusy = value} />
		{#if error}<p role="alert" class="whitespace-pre-wrap break-words text-sm text-red-800">{error}</p>{/if}
		<div class="flex gap-3">
			<button class="button" type="submit" disabled={busy || !name.trim()}>{mode === 'new' ? m['wordbooks.create']() : m['wordbooks.save']()}</button>
			<button class="button" type="button" disabled={submitting} onclick={() => cancel()}>{m['wordbooks.cancel']()}</button>
			{#if mode === 'rename' && ondelete}
				<button class="button ml-auto" type="button" aria-label={m['wordbooks.deleteBook']()} title={m['wordbooks.deleteBook']()} aria-describedby={!canDelete ? 'wordbook-delete-unavailable' : undefined} disabled={busy || !canDelete} onclick={ondelete}>
					<svg aria-hidden="true" class="size-5 text-red-800" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
				</button>
			{/if}
		</div>
		{#if mode === 'rename' && !canDelete}<p id="wordbook-delete-unavailable" class="text-sm text-slate-600">{m['wordbooks.lastBookDelete']()}</p>{/if}
	</form>
</dialog>

<style>
	dialog::backdrop { background: rgb(15 23 42 / 0.6); }
	.field { display: block; width: 100%; min-width: 0; border: 1px solid #94a3b8; border-radius: .375rem; padding: .5rem; background: white; }
	.button { min-height: 2.5rem; border: 1px solid #cbd5e1; border-radius: .375rem; padding: .5rem .75rem; background: white; font-size: .875rem; }
	.button:disabled { opacity: .5; cursor: not-allowed; }
	.button:focus-visible, .field:focus-visible { outline: 2px solid var(--shell-active, #047857); outline-offset: 2px; }
</style>
