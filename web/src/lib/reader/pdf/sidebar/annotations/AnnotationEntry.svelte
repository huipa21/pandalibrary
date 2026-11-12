<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import Icon, { type IconName } from '#lib/bookview/Icon.svelte';
	import type { AnnotationEntry } from './annotations-list.js';
	import { formatStamp } from './annotations-list.js';
	import { entryLabel } from './labels.js';
	import DeleteButton from './DeleteButton.svelte';

	let { entry, index, size, busy, readonly = false, flashed = false, onjump, ondelete, onexpand, onkey }: {
		entry: AnnotationEntry;
		index: number;
		size: number;
		busy: boolean;
		readonly?: boolean;
		flashed?: boolean;
		onjump: (entry: AnnotationEntry) => Promise<boolean>;
		ondelete: (entry: AnnotationEntry) => Promise<boolean>;
		onexpand: (entry: AnnotationEntry, trigger: HTMLButtonElement, readonly: boolean) => void;
		onkey?: (event: KeyboardEvent, index: number, part: 'body' | 'delete' | 'expand') => void;
	} = $props();
	const label = $derived(entry.excerpt || entryLabel(entry));
	const stamp = $derived(formatStamp(entry.createdAt, new Date(), getLocale()));
	const icon = $derived<IconName>(entry.kind === 'mark'
		? entry.swatch.style === 'underline' ? 'underline' : entry.swatch.style === 'strikeout' ? 'strikethrough' : 'highlighter'
		: entry.kind === 'text' ? 'type' : entry.kind === 'ink' ? 'pen' : 'image');
</script>

<li
	class="rp7-entry"
	class:rp7-entry-flash={flashed}
	data-panel-entry={entry.id}
	data-panel-kind={entry.kind}
	aria-posinset={index + 1}
	aria-setsize={size}
>
	<button
		type="button"
		class="rp7-entry-body"
		data-panel-jump={entry.id}
		data-panel-kind={entry.kind}
		disabled={readonly}
		onclick={() => onjump(entry)}
		onkeydown={(event) => onkey?.(event, index, 'body')}
	>
		<span
			class="rp7-swatch"
			class:rp7-fill={entry.kind === 'mark' && entry.swatch.style === 'highlight'}
			class:rp7-line={entry.kind === 'mark' && entry.swatch.style !== 'highlight'}
			style:background-color={entry.kind === 'mark' && entry.swatch.style === 'highlight' ? entry.swatch.hex : undefined}
			style:color={entry.kind === 'mark' && entry.swatch.style !== 'highlight' ? entry.swatch.hex : undefined}
			aria-hidden="true"
		>
			{#if entry.kind !== 'mark' || entry.swatch.style !== 'highlight'}<Icon name={icon} class="size-4" />{/if}
		</span>
		<time class="rp7-stamp" datetime={entry.createdAt} title={entry.createdAt}>{stamp}</time>
		<span class="rp7-excerpt" title={entry.excerpt}>{label}</span>
		<span class="rp7-comment" title={entry.commentExcerpt}>{entry.commentExcerpt}</span>
		<span class="rp7-page">{entry.page === null ? '' : m['rp7.page']({ page: entry.page })}</span>
	</button>
	{#if !readonly}
		<DeleteButton
			excerpt={label}
			{busy}
			ondelete={async () => { await ondelete(entry); }}
			onkeydown={(event) => onkey?.(event, index, 'delete')}
		/>
	{:else}
		<span class="rp7-action-spacer"></span>
	{/if}
	<button
		type="button"
		class="rp7-expand"
		data-rp7-expand
		aria-label={m['rp7.expand']({ excerpt: label })}
		title={m['rp7.expand']({ excerpt: label })}
		onclick={(event) => onexpand(entry, event.currentTarget, readonly)}
		onkeydown={(event) => onkey?.(event, index, 'expand')}
	><Icon name="external" class="size-4" /></button>
</li>
