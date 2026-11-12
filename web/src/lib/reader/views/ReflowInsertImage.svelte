<script lang="ts">
	import { annotationAssetUrl, releaseAnnotationAssetUrl } from '#lib/reader/assets/asset-cache.js';
	import * as m from '#lib/paraglide/messages.js';
	let { hash }: { hash: string } = $props();
	let url = $state('');
	let failed = $state(false);
	$effect(() => {
		let disposed = false;
		let objectUrl = '';
		url = ''; failed = false;
		void annotationAssetUrl(hash).then((value) => {
			objectUrl = value;
			if (disposed) releaseAnnotationAssetUrl(value);
			else url = value;
		}, () => { if (!disposed) failed = true; });
		return () => { disposed = true; if (objectUrl) releaseAnnotationAssetUrl(objectUrl); };
	});
</script>
{#if url}<img src={url} alt={m['pv9.image']()} draggable="false" />
{:else if failed}<span role="alert">{m['pv9.image_unavailable']()}</span>
{:else}<span role="status">{m['pv9.uploading']()}</span>{/if}
<style>
	img { width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
</style>
