<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import ToolbarMenu from './ToolbarMenu.svelte';
	import MenuItem from './MenuItem.svelte';

	let { flow, disabled = false, onflow }: {
		flow: 'paginated' | 'scrolled';
		disabled?: boolean;
		onflow: (flow: 'paginated' | 'scrolled') => void;
	} = $props();
</script>

<ToolbarMenu label={m['pv4.display']()} icon="layout-single" {disabled}>
	<MenuItem label={m['reader.settings.paginated']()} icon="layout-single"
		role="menuitemradio" checked={flow === 'paginated'} onchoose={() => onflow('paginated')} />
	<MenuItem label={m['reader.settings.scrolled']()} icon="layout-continuous"
		role="menuitemradio" checked={flow === 'scrolled'} onchoose={() => onflow('scrolled')} />
</ToolbarMenu>
