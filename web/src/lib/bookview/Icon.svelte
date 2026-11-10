<script lang="ts" module>
	export type IconName =
		| 'info' | 'play' | 'book-open' | 'external' | 'eye' | 'folder-plus'
		| 'download' | 'x' | 'chevron-left' | 'chevron-right' | 'chevron-down'
		| 'trash' | 'copy' | 'more' | 'star' | 'star-half' | 'pencil'
		| 'search' | 'plus' | 'refresh' | 'file' | 'arrow-left'
		| 'zoom-in' | 'zoom-out' | 'zoom-auto' | 'fit-page' | 'fit-width'
		| 'actual-size' | 'layout-single' | 'layout-continuous' | 'layout-split'
		| 'layout-split-continuous' | 'rotate-ccw' | 'rotate-cw' | 'hand'
		| 'text-cursor' | 'insert' | 'panel-right'
		| 'highlighter' | 'underline' | 'strikethrough' | 'message' | 'bookmark-plus'
		| 'type' | 'pen' | 'image' | 'undo' | 'check' | 'move'
		| 'list-tree' | 'bookmark' | 'chevrons-left';
</script>

<script lang="ts">
	let { name, class: className = 'size-5' }: { name: IconName; class?: string } = $props();
</script>

<svg
	aria-hidden="true"
	class={className}
	viewBox={['zoom-in', 'zoom-out', 'zoom-auto', 'fit-page', 'fit-width', 'actual-size', 'layout-single', 'layout-continuous', 'layout-split', 'layout-split-continuous', 'rotate-ccw', 'rotate-cw', 'hand', 'text-cursor', 'insert', 'panel-right', 'highlighter', 'underline', 'strikethrough', 'message', 'bookmark-plus', 'type', 'pen', 'image', 'undo', 'check', 'move'].includes(name) ? '0 0 20 20' : '0 0 24 24'}
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
	{:else if name === 'arrow-left'}
		<path d="M19 12H5m6-6-6 6 6 6" />
	{:else if name === 'zoom-in' || name === 'zoom-out'}
		<circle cx="8" cy="8" r="5" /><path d="m12 12 5 5M5.5 8h5" />
		{#if name === 'zoom-in'}<path d="M8 5.5v5" />{/if}
	{:else if name === 'zoom-auto'}
		<circle cx="8" cy="8" r="5" /><path d="m12 12 5 5M5.5 10 8 5l2.5 5M6.5 8.5h3" />
	{:else if name === 'fit-page'}
		<path d="M6 2h8v16H6zM2 6V2h2m12 0h2v4M2 14v4h2m12 0h2v-4" />
	{:else if name === 'fit-width'}
		<path d="M6 2h8v4M6 14v4h8v-4M2 10h16M5 7l-3 3 3 3m10-6 3 3-3 3" />
	{:else if name === 'actual-size'}
		<path d="M3 2h14v16H3zM6 8l2-1v6m4-5 2-1v6" />
	{:else if name === 'layout-single'}
		<rect x="4" y="2" width="12" height="16" rx="1" />
	{:else if name === 'layout-continuous'}
		<path d="M4 1h12v4H4zM4 8h12v11H4z" />
	{:else if name === 'layout-split'}
		<rect x="2" y="3" width="16" height="14" rx="1" /><path d="M10 3v14" />
	{:else if name === 'layout-split-continuous'}
		<path d="M2 1h16v4H2zM2 8h16v11H2zM10 1v4m0 3v11" />
	{:else if name === 'rotate-ccw'}
		<path d="M3 3v5h5M3 8a7 7 0 1 1 0 5" />
	{:else if name === 'rotate-cw'}
		<path d="M17 3v5h-5m5 0a7 7 0 1 0 0 5" />
	{:else if name === 'hand'}
		<path d="M6 10V5a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v5-2a1.5 1.5 0 0 1 3 0v5c0 4-2 6-6 6H9c-2 0-3-1-4-3l-3-5c-1-2 1-3 2-2l2 2" />
	{:else if name === 'text-cursor'}
		<path d="M6 2h2l2 2 2-2h2M10 4v12m-4 2h2l2-2 2 2h2" />
	{:else if name === 'insert'}
		<circle cx="10" cy="10" r="8" /><path d="M10 6v8M6 10h8" />
	{:else if name === 'panel-right'}
		<rect x="2" y="3" width="16" height="14" rx="1" /><path d="M12 3v14m3-10h.01M15 10h.01M15 13h.01" />
	{:else if name === 'highlighter'}
		<path d="m6 11 8-8 3 3-8 8-3-3Zm0 0-2 4 2 2 3-3M2 18h8" />
	{:else if name === 'underline'}
		<path d="M5 3v7a5 5 0 0 0 10 0V3M3 18h14" />
	{:else if name === 'strikethrough'}
		<path d="M15 5c-1-3-10-3-10 1 0 2 2 3 5 4s5 2 5 4c0 4-9 4-10 1M2 10h16" />
	{:else if name === 'message'}
		<path d="M3 3h14v11H8l-5 3V3Zm3 4h8m-8 3h5" />
	{:else if name === 'bookmark-plus'}
		<path d="M4 2h12v16l-6-4-6 4V2Zm6 3v6M7 8h6" />
	{:else if name === 'type'}
		<path d="M3 5V3h14v2M10 3v14m-3 0h6" />
	{:else if name === 'pen'}
		<path d="m4 13 9-10 4 4-10 9-4 1 1-4Zm7-8 4 4M2 19h16" />
	{:else if name === 'image'}
		<rect x="2" y="3" width="16" height="14" rx="1" /><circle cx="7" cy="7" r="1" /><path d="m2 14 5-4 4 3 3-3 4 4" />
	{:else if name === 'undo'}
		<path d="M7 3 2 8l5 5M2 8h10a5 5 0 0 1 0 10h-2" />
	{:else if name === 'check'}
		<path d="m3 10 5 5L17 5" />
	{:else if name === 'move'}
		<path d="M10 2v16M2 10h16M7 5l3-3 3 3m-6 10 3 3 3-3M5 7l-3 3 3 3m10-6 3 3-3 3" />
	{:else if name === 'list-tree'}
		<path d="M3 5h4m-2 0v12a2 2 0 0 0 2 2h1M5 12h3M11 5h10M11 12h10M11 19h10" />
	{:else if name === 'bookmark'}
		<path d="M6 3h12v18l-6-4-6 4z" />
	{:else if name === 'chevrons-left'}
		<path d="m11 17-5-5 5-5m7 10-5-5 5-5" />
	{/if}
</svg>
