<script lang="ts">
	import type { ReadStatus } from './user-book.js';

	let { status, class: className = 'size-5' }: { status: ReadStatus; class?: string } = $props();
</script>

<svg
	aria-hidden="true"
	data-status-icon={status}
	class={className}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.75"
	stroke-linecap="round"
	stroke-linejoin="round"
>
	{#if status === 'unread'}
		<path d="M6 4.5A2.5 2.5 0 0 1 8.5 2H19v16H8.5A2.5 2.5 0 0 0 6 20.5zm0 0v16A1.5 1.5 0 0 0 7.5 22H19v-4" />
	{:else if status === 'want_to_read'}
		<path d="M6 4.5A2.5 2.5 0 0 1 8.5 2H19v16H8.5A2.5 2.5 0 0 0 6 20.5zm0 0v16A1.5 1.5 0 0 0 7.5 22H19v-4" />
		<path d="M13 2v8l2-1.5L17 10V2" />
	{:else if status === 'reading'}
		<path d="M12 6.5c-2-2-5-2.5-9-1.5v13c4-1 7-.5 9 1.5m0-13c2-2 5-2.5 9-1.5v13c-4-1-7-.5-9 1.5m0-13v13" />
	{:else if status === 'on_hold'}
		<rect x="6" y="4" width="4" height="16" rx="1.5" /><rect x="14" y="4" width="4" height="16" rx="1.5" />
	{:else if status === 'rereading'}
		<path d="M4 10V5m0 5h5M4.6 9a8 8 0 1 1-.2 6" />
	{:else if status === 'finished'}
		<path d="M6 4.5A2.5 2.5 0 0 1 8.5 2H19v16H8.5A2.5 2.5 0 0 0 6 20.5zm0 0v16A1.5 1.5 0 0 0 7.5 22H19v-4" />
		<path d="m10 10 2 2 4-4" />
	{:else if status === 'skimmed'}
		<path d="M4 9V4h5m6 0h5v5M20 15v5h-5M9 20H4v-5" stroke-dasharray="2 2" />
		<path d="M7 12h10" />
	{:else if status === 'abandoned'}
		<path d="M6 4.5A2.5 2.5 0 0 1 8.5 2H19v16H8.5A2.5 2.5 0 0 0 6 20.5zm0 0v16A1.5 1.5 0 0 0 7.5 22H19v-4" />
		<path d="m11 7 5 5m0-5-5 5" />
	{/if}
</svg>
