<script lang="ts">
	import ShelfNavigation from '#lib/shelves/ShelfNavigation.svelte';

	let { pathname, role }: { pathname: string; role: string } = $props();
</script>

<ShelfNavigation {pathname} {role} />
