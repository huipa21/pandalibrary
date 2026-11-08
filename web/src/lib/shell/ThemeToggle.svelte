<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { applyTheme, readTheme, saveTheme, type Theme } from './theme.js';

	interface Props {
		compact?: boolean;
	}

	let { compact = false }: Props = $props();
	let theme = $state<Theme>(readTheme());

	onMount(() => {
		const syncTheme = (event: Event) => {
			theme = (event as CustomEvent<Theme>).detail;
		};
		window.addEventListener('pandalibrary:theme-change', syncTheme);
		return () => window.removeEventListener('pandalibrary:theme-change', syncTheme);
	});

	function toggle() {
		theme = theme === 'dark' ? 'light' : 'dark';
		applyTheme(theme);
		saveTheme(theme);
		window.dispatchEvent(new CustomEvent('pandalibrary:theme-change', { detail: theme }));
	}
</script>

<button
	type="button"
	class={compact ? 'shell-menu-row' : 'shell-icon-button size-9'}
	aria-label={theme === 'dark' ? m['hm1.theme.to_light']() : m['hm1.theme.to_dark']()}
	title={theme === 'dark' ? m['hm1.theme.to_light']() : m['hm1.theme.to_dark']()}
	aria-pressed={theme === 'dark'}
	onclick={toggle}
>
	{#if theme === 'dark'}
		<svg aria-hidden="true" viewBox="0 0 20 20" class="size-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
			<circle cx="10" cy="10" r="3" />
			<path d="M10 2v2m0 12v2M2 10h2m12 0h2M4.34 4.34l1.42 1.42m8.48 8.48 1.42 1.42m0-11.32-1.42 1.42m-8.48 8.48-1.42 1.42" />
		</svg>
	{:else}
		<svg aria-hidden="true" viewBox="0 0 20 20" class="size-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
			<path d="M16.8 12.1A7.2 7.2 0 0 1 7.9 3.2 7.3 7.3 0 1 0 16.8 12.1Z" />
		</svg>
	{/if}
	{#if compact}<span>{m['hm1.theme.label']()}</span>{/if}
</button>
