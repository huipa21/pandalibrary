<script lang="ts">
	import StickyNote from '../../StickyNote.svelte';
	import { floatAt } from './float-at.js';
	import type { RectLike } from './floating.js';

	let { anchor, bounds, initial, disabled = false, onsave, oncancel }: {
		anchor: RectLike;
		bounds: RectLike;
		initial: string;
		disabled?: boolean;
		onsave: (body: string) => void;
		oncancel: (body: string) => void;
	} = $props();

</script>

<div
	use:floatAt={{ anchor, bounds }}
	class="pv8-floating pv8-comment"
	data-testid="pv8-comment"
>
	<StickyNote {initial} {disabled} {onsave} {oncancel} />
</div>
