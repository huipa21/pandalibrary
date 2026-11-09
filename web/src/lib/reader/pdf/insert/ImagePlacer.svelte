<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { prepareAnnotationImage, uploadAnnotationAsset } from '../../assets/assets-api.js';
	import { AnnotationImageError } from '../../assets/errors.js';
	import type { PageLayerContext, NormalizedPoint } from '../types.js';
	import type { PageAnnotationInput } from '../../types.js';
	import { imageRect } from './geometry-insert.js';
	let { ctx, point, save, cancel, announce }: {
		ctx: PageLayerContext; point: NormalizedPoint; save(input: PageAnnotationInput): Promise<boolean | undefined>;
		cancel(): void; announce(message: string): void;
	} = $props();
	let input: HTMLInputElement;
	let busy = $state(false);
	let placement = $state<PageAnnotationInput | null>(null);
	let alive = true;
	onMount(() => { input.click(); return () => { alive = false; }; });
	async function upload() {
		const file = input.files?.[0];
		if (!file) { cancel(); return; }
		busy = true;
		try {
			const prepared = await prepareAnnotationImage(file);
			const asset = await uploadAnnotationAsset(prepared);
			if (!alive) return;
			placement = {
				kind: 'image', locator: { type: 'pdf', page: ctx.page,
					rect: imageRect(point, asset.width / asset.height, ctx.width, ctx.height) },
				position: 0, data: { asset: asset.sha256, media_type: asset.media_type, width: asset.width, height: asset.height }
			};
			await commit();
		} catch (error) {
			console.error('Could not attach annotation image', error);
			if (alive) {
				announce(error instanceof AnnotationImageError ? error.message : m['pv9.upload_failed']());
				cancel();
			}
		}
	}
	async function commit() {
		if (!placement) return;
		busy = true;
		if (!await save(placement)) busy = false;
	}
</script>
<input bind:this={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onchange={upload} oncancel={cancel} />
{#if busy}<div class="pv9-upload" role="status"><progress aria-label={m['pv9.uploading']()}></progress> {m['pv9.uploading']()}</div>{/if}
{#if placement && !busy}<div class="pv9-upload"><button onclick={commit}>{m['pv9.retry']()}</button> <button onclick={cancel}>{m['pv9.cancel']()}</button></div>{/if}
<style>
	.pv9-upload { position: absolute; top: 10px; left: 10px; padding: 8px; background: var(--pv-chrome, white); color: var(--shell-text, #111827); pointer-events: auto; }
</style>
