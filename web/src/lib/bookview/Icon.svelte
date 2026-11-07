<script lang="ts" module>
	export type IconName =
		| 'info' | 'play' | 'book-open' | 'external' | 'eye' | 'folder-plus'
		| 'download' | 'x' | 'chevron-left' | 'chevron-right' | 'chevron-down'
		| 'trash' | 'copy' | 'more' | 'star' | 'star-half' | 'pencil'
		| 'search' | 'plus' | 'refresh' | 'file';
</script>

<script lang="ts">
	let { name, class: className = 'size-5' }: { name: IconName; class?: string } = $props();
</script>

<svg
	aria-hidden="true"
	class={className}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.75"
	stroke-linecap="round"
	stroke-linejoin="round"
>
	{#if name === 'info'}
		<circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" />
	{:else if name === 'play'}
		<path d="m8 5 11 7-11 7z" />
	{:else if name === 'book-open'}
		<path d="M12 6.5c-2-2-5-2.5-9-1.5v13c4-1 7-.5 9 1.5m0-13c2-2 5-2.5 9-1.5v13c-4-1-7-.5-9 1.5m0-13v13" />
	{:else if name === 'external'}
		<path d="M13 5h6v6m0-6-9 9M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" />
	{:else if name === 'eye'}
		<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" />
	{:else if name === 'folder-plus'}
		<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6m-3-3h6" />
	{:else if name === 'download'}
		<path d="M12 3v12m-4-4 4 4 4-4M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
	{:else if name === 'x'}
		<path d="M6 6l12 12M18 6 6 18" />
	{:else if name === 'chevron-left'}
		<path d="m15 6-6 6 6 6" />
	{:else if name === 'chevron-right'}
		<path d="m9 6 6 6-6 6" />
	{:else if name === 'chevron-down'}
		<path d="m6 9 6 6 6-6" />
	{:else if name === 'trash'}
		<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" />
	{:else if name === 'copy'}
		<rect x="8" y="8" width="11" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2" />
	{:else if name === 'more'}
		<circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
	{:else if name === 'star' || name === 'star-half'}
		<path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2-5.7-3-5.7 3 1.1-6.2-4.5-4.4 6.3-.9z" />
		{#if name === 'star-half'}
			<path d="M12 3v14.2l-5.7 3 1.1-6.2L2.9 9.6l6.3-.9z" fill="currentColor" stroke="none" />
		{/if}
	{:else if name === 'pencil'}
		<path d="m4 20 4.2-.8L19 8.4 15.6 5 4.8 15.8zM14 6.6 17.4 10M4 20l.8-4.2" />
	{:else if name === 'search'}
		<circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4 4" />
	{:else if name === 'plus'}
		<path d="M12 5v14M5 12h14" />
	{:else if name === 'refresh'}
		<path d="M20 7v5h-5M4 17v-5h5M5 9a7 7 0 0 1 12-2l3 5M19 15a7 7 0 0 1-12 2l-3-5" />
	{:else if name === 'file'}
		<path d="M6 3h8l4 4v14H6zM14 3v5h4" />
	{/if}
</svg>
