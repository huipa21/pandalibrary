<script lang="ts">
	import type { Snippet } from 'svelte';

	let { label, activeLabel, hint, testId, disabled = false, ondrop, children }: {
		label: string;
		activeLabel: string;
		hint: string;
		testId?: string;
		disabled?: boolean;
		ondrop: (event: DragEvent) => void;
		children: Snippet;
	} = $props();
	const labelId = $props.id();
	let dragDepth = $state(0);

	$effect(() => {
		if (disabled) dragDepth = 0;
	});
</script>

<div
	role="group"
	aria-labelledby={labelId}
	aria-disabled={disabled || undefined}
	data-testid={testId}
	data-dragging={!disabled && dragDepth > 0 ? 'true' : undefined}
	class={[
		'upload-dropzone flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors',
		!disabled && dragDepth > 0 ? 'border-emerald-500 bg-emerald-50' : 'border-slate-300 bg-slate-50'
	]}
	ondragenter={(event) => { event.preventDefault(); if (!disabled) dragDepth += 1; }}
	ondragover={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'; }}
	ondragleave={() => dragDepth = Math.max(0, dragDepth - 1)}
	ondrop={(event) => { event.preventDefault(); dragDepth = 0; if (!disabled) ondrop(event); }}
>
	<svg aria-hidden="true" viewBox="0 0 24 24" class="size-8 text-slate-400" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
		<path d="M12 16V4m0 0L7 9m5-5l5 5M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
	</svg>
	<p id={labelId} class="text-sm font-medium">{!disabled && dragDepth > 0 ? activeLabel : label}</p>
	<p class="text-xs text-slate-600">{hint}</p>
	{@render children()}
</div>
