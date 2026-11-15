<script lang="ts">
	import { onDestroy } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import BookCover from './BookCover.svelte';
	import { coverColors } from './cover.js';
	import { CoverImageError, cropRect, exportCoverCrop, validateCoverFile } from './image-crop.js';

	interface Props {
		title: string;
		seed?: number;
		color?: string;
		image?: string;
		disabled?: boolean;
		/** Blocks saving during processing or unresolved errors, never cancellation. */
		onbusy?: (busy: boolean) => void;
	}

	let { title, seed = 0, color = $bindable(''), image = $bindable(''), disabled = false, onbusy }: Props = $props();
	let source = $state<{ element: HTMLImageElement; url: string; width: number; height: number } | null>(null);
	let panX = $state(50);
	let panY = $state(50);
	let zoom = $state(1);
	let loading = $state(false);
	let exporting = $state(false);
	let invalidCrop = $state(false);
	let invalidUpload = $state(false);
	let error = $state('');
	let uploadVersion = 0;
	let destroyed = false;
	let cancelLoad: (() => void) | undefined;
	let drag: { pointer: number; x: number; y: number; panX: number; panY: number } | null = null;
	const selection = $derived(source ? cropRect(source.width, source.height, panX / 100, panY / 100, zoom) : null);
	const paletteLabels = $derived({
		navy: m['covers.editor.navy'](), forest: m['covers.editor.forest'](),
		ochre: m['covers.editor.ochre'](), khaki: m['covers.editor.khaki'](),
		rust: m['covers.editor.rust'](), taupe: m['covers.editor.taupe'](),
		burgundy: m['covers.editor.burgundy'](), 'slate-teal': m['covers.editor.slate_teal']()
	});

	function errorMessage(cause: unknown): string {
		switch (cause instanceof CoverImageError ? cause.code : 'decode') {
			case 'type': return m['covers.editor.error_type']();
			case 'size': return m['covers.editor.error_size']();
			case 'encode': return m['covers.editor.error_encode']();
			default: return m['covers.editor.error_decode']();
		}
	}

	async function upload(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		const version = ++uploadVersion;
		cancelLoad?.();
		loading = true;
		invalidUpload = false;
		error = '';
		let url = '';
		try {
			await validateCoverFile(file);
			if (destroyed || version !== uploadVersion) return;
			url = URL.createObjectURL(file);
			const element = new Image();
			await new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					element.onload = null;
					element.onerror = null;
					cancelLoad = undefined;
				};
				cancelLoad = () => {
					cleanup();
					element.src = '';
					reject(new CoverImageError('decode'));
				};
				element.onload = () => { cleanup(); resolve(); };
				element.onerror = () => { cleanup(); reject(new CoverImageError('decode')); };
				element.src = url;
			});
			if (destroyed || version !== uploadVersion) return;
			if (!element.naturalWidth || !element.naturalHeight || element.naturalWidth * element.naturalHeight > 40_000_000) {
				throw new CoverImageError('decode');
			}
			if (source) URL.revokeObjectURL(source.url);
			source = { element, url, width: element.naturalWidth, height: element.naturalHeight };
			url = '';
			panX = panY = 50;
			zoom = 1;
		} catch (cause) {
			if (!destroyed && version === uploadVersion) {
				error = errorMessage(cause);
				invalidUpload = true;
			}
		} finally {
			if (url) URL.revokeObjectURL(url);
			if (!destroyed && version === uploadVersion) loading = false;
		}
	}

	function generated() {
		uploadVersion++;
		cancelLoad?.();
		loading = false;
		if (source) URL.revokeObjectURL(source.url);
		source = null;
		image = '';
		invalidCrop = false;
		invalidUpload = false;
		error = '';
	}

	function changedCrop() {
		error = '';
		invalidUpload = false;
	}

	function startDrag(event: PointerEvent) {
		if (disabled || loading) return;
		event.preventDefault();
		event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId);
		drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, panX, panY };
	}

	function moveDrag(event: PointerEvent) {
		if (!drag || drag.pointer !== event.pointerId || !source || !selection || disabled || loading) return;
		const bounds = (event.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
		const freeX = bounds.width * (1 - selection.width / source.width);
		const freeY = bounds.height * (1 - selection.height / source.height);
		if (freeX > 0) panX = Math.max(0, Math.min(100, drag.panX + (event.clientX - drag.x) / freeX * 100));
		if (freeY > 0) panY = Math.max(0, Math.min(100, drag.panY + (event.clientY - drag.y) / freeY * 100));
		changedCrop();
	}

	$effect(() => {
		const current = source;
		const crop = selection;
		if (!current || !crop || loading || invalidUpload) {
			exporting = false;
			if (!current) invalidCrop = false;
			return;
		}
		let cancelled = false;
		exporting = true;
		invalidCrop = true;
		const timer = setTimeout(async () => {
			try {
				const result = await exportCoverCrop(current.element, crop);
				if (!cancelled) {
					image = result;
					invalidCrop = false;
				}
			} catch (cause) {
				if (!cancelled) error = errorMessage(cause);
			} finally {
				if (!cancelled) exporting = false;
			}
		}, 120);
		return () => { cancelled = true; clearTimeout(timer); };
	});

	$effect(() => { onbusy?.(loading || exporting || invalidCrop || invalidUpload); });

	onDestroy(() => {
		destroyed = true;
		uploadVersion++;
		cancelLoad?.();
		if (source) URL.revokeObjectURL(source.url);
		onbusy?.(false);
	});
</script>

<fieldset class="cover-editor" {disabled} aria-busy={loading || exporting}>
	<legend>{m['covers.editor.label']()}</legend>
	<div class="preview">
		<BookCover id={seed} {title} coverUrl={image} coverColor={color} centeredTitle loading="eager" />
	</div>
	<label>
		<span>{m['covers.editor.color']()}</span>
		<select bind:value={color} onchange={generated}>
			<option value="">{m['covers.editor.automatic']()}</option>
			{#each coverColors as palette}
				<option value={palette.name}>{paletteLabels[palette.name]}</option>
			{/each}
		</select>
	</label>
	<label>
		<span>{m['covers.editor.upload']()}</span>
		<input type="file" accept="image/jpeg,image/png,image/webp" onchange={upload} />
	</label>
	<p class="hint">{m['covers.editor.upload_help']()}</p>
	{#if source && selection}
		<p class="hint">{m['covers.editor.crop_help']()}</p>
		<div class="original" style:aspect-ratio={`${source.width} / ${source.height}`} style:max-width={`${Math.min(24, 24 * source.width / source.height)}rem`}>
			<img src={source.url} alt={m['covers.editor.original']()} draggable="false" />
			<button
				type="button"
				class="selection"
				aria-label={m['covers.editor.drag']()}
				disabled={disabled || loading}
				style:left={`${selection.x / source.width * 100}%`}
				style:top={`${selection.y / source.height * 100}%`}
				style:width={`${selection.width / source.width * 100}%`}
				style:height={`${selection.height / source.height * 100}%`}
				onpointerdown={startDrag}
				onpointermove={moveDrag}
				onpointerup={() => drag = null}
				onpointercancel={() => drag = null}
			></button>
		</div>
		<label>
			<span>{m['covers.editor.pan_x']()}</span>
			<input type="range" min="0" max="100" step="1" bind:value={panX} disabled={disabled || loading} oninput={changedCrop} />
		</label>
		<label>
			<span>{m['covers.editor.pan_y']()}</span>
			<input type="range" min="0" max="100" step="1" bind:value={panY} disabled={disabled || loading} oninput={changedCrop} />
		</label>
		<label>
			<span>{m['covers.editor.zoom']()}</span>
			<input type="range" min="1" max="5" step="0.05" bind:value={zoom} disabled={disabled || loading} oninput={changedCrop} />
		</label>
	{/if}
	{#if image || source || loading || error}
		<button class="generated" type="button" onclick={generated}>{m['covers.editor.generated']()}</button>
	{/if}
	{#if loading || exporting}<p role="status">{m['covers.editor.processing']()}</p>{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</fieldset>

<style>
	.cover-editor { display: grid; min-width: 0; gap: 0.65rem; }
	legend { margin-bottom: 0.5rem; font-weight: 600; }
	.preview { width: 8rem; margin-inline: auto; }
	label { display: grid; gap: 0.5rem; font-size: 0.875rem; }
	select, .generated { border: 1px solid #94a3b8; border-radius: 0.375rem; padding: 0.4rem; }
	select { background: white; color: #0f172a; }
	input[type='range'] { width: 100%; }
	.hint { color: #64748b; font-size: 0.8rem; }
	.original { position: relative; width: 100%; margin-inline: auto; overflow: hidden; }
	.original img { display: block; width: 100%; height: 100%; }
	.selection { position: absolute; border: 2px solid white; outline: 1px solid #0f172a; box-shadow: 0 0 0 100vmax rgb(0 0 0 / 48%); background: transparent; cursor: grab; touch-action: none; }
	.selection:focus-visible { border-color: #fbbf24; outline: 3px solid #0f172a; }
	.selection:active { cursor: grabbing; }
	.error { color: #b91c1c; font-size: 0.875rem; }
	:disabled { opacity: 0.65; }
</style>
