<script lang="ts">
	import { onMount, tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { FoliateReader, ReflowInsertionTarget } from '#lib/reader/foliate.js';
	import type { ReaderController } from '#lib/reader/session/reader-controller.svelte.js';
	import type { PageAnnotation, PageAnnotationInput, ImageData } from '#lib/reader/types.js';
	import type { InsertType } from '#lib/reader/toolbar/InsertMenu.svelte';
	import { quantize, simplifyStroke } from '#lib/reader/page-annotations.js';
	import { prepareAnnotationImage, uploadAnnotationAsset } from '#lib/reader/assets/assets-api.js';
	import { AnnotationImageError } from '#lib/reader/assets/errors.js';
	import ReflowInsertImage from './ReflowInsertImage.svelte';

	let { engine, controller, surface, mode = $bindable(null), announce }: {
		engine: FoliateReader; controller: ReaderController; surface: HTMLElement;
		mode: InsertType | null; announce(message: string): void;
	} = $props();
	let target = $state<ReflowInsertionTarget | null>(null);
	let kind = $state<InsertType | null>(null);
	let text = $state('');
	let strokes = $state<number[][]>([]);
	let image = $state<ImageData | null>(null);
	let editing = $state<PageAnnotation | null>(null);
	let selected = $state<string | null>(null);
	let saving = $state(false);
	let revision = $state(0);
	let textarea = $state<HTMLTextAreaElement>();
	let fileInput = $state<HTMLInputElement>();
	let canvas = $state<SVGSVGElement>();
	let pointer: number | null = null;
	let alive = true;
	let animation = 0;
	const rows = $derived(controller.pageAnnotations.filter((row) => row.locator.type === 'cfi'));
	const placements = $derived.by(() => {
		void revision;
		void controller.location;
		return rows.flatMap((row) => {
			const bounds = engine.getInsertionBounds(row.locator);
			return bounds && row.id !== editing?.id ? [{ row, bounds }] : [];
		});
	});
	const draftBounds = $derived.by(() => {
		void revision;
		void controller.location;
		return target ? engine.getInsertionBounds(target.locator) : null;
	});
	const clip = $derived.by(() => {
		void revision;
		const rect = surface.getBoundingClientRect();
		return `inset(${rect.top}px ${Math.max(0, window.innerWidth - rect.right)}px ${Math.max(0, window.innerHeight - rect.bottom)}px ${rect.left}px)`;
	});
	function refresh() {
		cancelAnimationFrame(animation);
		animation = requestAnimationFrame(() => { revision += 1; });
	}
	function discard() {
		target = null; kind = null; editing = null; text = ''; strokes = []; image = null; mode = null;
	}
	function canDiscard() {
		return !target || !text.trim() && !strokes.length && !image || window.confirm(m['pv9.discard_insert']());
	}
	function place(placement: ReflowInsertionTarget) {
		kind = mode;
		mode = null;
		text = ''; strokes = []; image = null;
		target = placement;
		engine.clearSelection();
		refresh();
		void tick().then(() => {
			if (kind === 'text') textarea?.focus();
			if (kind === 'image') fileInput?.click();
		});
	}
	$effect(() => {
		if (!mode) return;
		if (target && !canDiscard()) { mode = null; return; }
		target = null; selected = null; editing = null;
		return engine.subscribeInsertion(place);
	});
	onMount(() => {
		const unsubscribe = engine.subscribeSelection(refresh);
		const unguard = controller.registerDraftGuard(() => !saving && canDiscard());
		const resize = new ResizeObserver(refresh);
		resize.observe(surface);
		const key = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && (mode || target || selected)) {
				event.preventDefault(); event.stopPropagation();
				if (!saving && canDiscard()) { discard(); selected = null; }
			}
		};
		window.addEventListener('keydown', key, true);
		refresh();
		return () => {
			alive = false; unsubscribe(); unguard(); resize.disconnect();
			cancelAnimationFrame(animation); window.removeEventListener('keydown', key, true);
		};
	});
	async function save() {
		if (!target || saving) return;
		let input: PageAnnotationInput;
		if (kind === 'text') {
			if (!text.trim()) { discard(); return; }
			input = { ...target, kind: 'text', data: { text, color: '#111827', size: 0.028 } };
		} else if (kind === 'draw') {
			if (!strokes.length) { discard(); return; }
			input = { ...target, kind: 'ink', data: {
				color: '#2563eb', width: 0.003,
				strokes: strokes.map((stroke) => quantize(simplifyStroke(stroke)))
			} };
		} else {
			if (!image) return;
			input = { ...target, kind: 'image', data: image };
		}
		saving = true;
		const success = editing
			? await controller.updatePageAnnotation(editing, input)
			: await controller.addPageAnnotation(input);
		saving = false;
		if (success) discard();
		else announce(controller.actionError || m['pv9.save_failed']());
	}
	async function upload() {
		const file = fileInput?.files?.[0];
		if (!file) return;
		saving = true;
		try {
			const asset = await uploadAnnotationAsset(await prepareAnnotationImage(file));
			if (!alive) return;
			image = { asset: asset.sha256, media_type: asset.media_type, width: asset.width, height: asset.height };
		} catch (error) {
			if (alive) announce(error instanceof AnnotationImageError ? error.message : m['pv9.upload_failed']());
		} finally { if (alive) saving = false; }
	}
	function point(event: PointerEvent) {
		const rect = canvas!.getBoundingClientRect();
		return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
			Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))];
	}
	function draw(event: PointerEvent) {
		if (pointer !== event.pointerId || saving) return;
		const stroke = strokes.at(-1)!;
		if (stroke.length >= 20000) return;
		stroke.push(...point(event));
		strokes = [...strokes];
	}
	function edit(row: PageAnnotation) {
		if (row.locator.type !== 'cfi' || row.kind !== 'text' || !canDiscard()) return;
		mode = null; editing = row; selected = null; kind = 'text';
		target = { locator: row.locator, position: row.position }; text = row.data.text;
		void tick().then(() => textarea?.focus());
	}
	async function remove(row: PageAnnotation) {
		if (await controller.removePageAnnotation(row)) selected = null;
		else announce(controller.actionError || m['pv9.save_failed']());
	}
</script>

<div class="reflow-inserts" style:clip-path={clip} data-testid="reflow-inserts">
	{#if mode}
		<button class="placement-surface" aria-label={m['pv9.place_prompt']()} onclick={(event) => {
			try { place(engine.insertionAt(event.clientX, event.clientY)); }
			catch (error) { announce(error instanceof Error ? error.message : m['pv9.save_failed']()); }
		}}></button>
	{/if}
	{#each placements as { row, bounds } (row.id)}
		<div class="insert" data-annotation-id={row.id}
			style:left={`${bounds.left}px`} style:top={`${bounds.top}px`}
			style:width={`${bounds.width}px`} style:height={`${bounds.height}px`}>
			<button class="content" aria-label={row.kind === 'text' ? m['pv9.text_note']({ text: row.data.text }) : row.kind === 'ink' ? m['pv9.drawing']() : m['pv9.image']()}
				onclick={() => selected = row.id} ondblclick={() => edit(row)}
				onkeydown={(event) => {
					if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); void remove(row); }
					if (event.key === 'Enter' && row.kind === 'text') edit(row);
				}}>
				{#if row.kind === 'text'}
					<span style:color={row.data.color} style:font-size={`${Math.max(12, row.data.size * bounds.height / row.locator.rect.height)}px`}>{row.data.text}</span>
				{:else if row.kind === 'ink'}
					<svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
						{#each row.data.strokes as stroke}
							<polyline points={stroke.reduce<string[]>((points, value, index) => {
								if (index % 2 === 0) points.push(`${value},${stroke[index + 1]}`);
								return points;
							}, []).join(' ')} fill="none" stroke={row.data.color} stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" />
						{/each}
					</svg>
				{:else}<ReflowInsertImage hash={row.data.asset} />{/if}
			</button>
			{#if selected === row.id}
				<div class="actions">
					{#if row.kind === 'text'}<button disabled={controller.busy} onclick={() => edit(row)}>{m['reader.annotations.edit']()}</button>{/if}
					<button disabled={controller.busy} onclick={() => remove(row)}>{m['reader.annotations.delete']()}</button>
					<button onclick={() => selected = null}>{m['pv9.cancel']()}</button>
				</div>
			{/if}
		</div>
	{/each}
	{#if target && draftBounds}
		<div class="insert draft" role="dialog" tabindex="-1" aria-label={kind === 'text' ? m['pv9.text']() : kind === 'draw' ? m['pv9.drawing']() : m['pv9.image']()}
			style:left={`${draftBounds.left}px`} style:top={`${draftBounds.top}px`}
			style:width={`${draftBounds.width}px`} style:height={`${draftBounds.height}px`}>
			{#if kind === 'text'}
				<textarea bind:this={textarea} bind:value={text} maxlength="4000" aria-label={m['pv9.text']()} disabled={saving}
					onkeydown={(event) => { if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); void save(); } }}></textarea>
			{:else if kind === 'draw'}
				<svg bind:this={canvas} viewBox="0 0 1 1" preserveAspectRatio="none" role="img" aria-label={m['pv9.drawing']()}
					onpointerdown={(event) => {
						if (saving || strokes.length >= 200) return;
						event.preventDefault(); pointer = event.pointerId; canvas!.setPointerCapture(pointer);
						strokes = [...strokes, point(event)];
					}} onpointermove={draw} onpointerup={(event) => { draw(event); pointer = null; }}
					onpointercancel={() => pointer = null}>
					{#each strokes as stroke}
						<polyline points={stroke.reduce<string[]>((points, value, index) => {
							if (index % 2 === 0) points.push(`${value},${stroke[index + 1]}`);
							return points;
						}, []).join(' ')} fill="none" stroke="#2563eb" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" />
					{/each}
				</svg>
			{:else if image}<ReflowInsertImage hash={image.asset} />{/if}
			<div class="actions">
				{#if kind === 'image'}
					<input bind:this={fileInput} type="file" accept="image/png,image/jpeg,image/webp" disabled={saving} onchange={upload} aria-label={m['pv9.image']()} />
				{/if}
				<button disabled={saving || kind === 'image' && !image} onclick={save}>{m['pv9.done']()}</button>
				<button disabled={saving} onclick={() => { if (canDiscard()) discard(); }}>{m['pv9.cancel']()}</button>
				{#if saving}<span role="status">{m['reader.loading']()}</span>{/if}
			</div>
		</div>
	{/if}
</div>
{#if mode}<div class="placement-hint" role="status">{m['pv9.place_prompt']()} <button onclick={() => mode = null}>{m['pv9.cancel']()}</button></div>{/if}
{#if target && !draftBounds}
	<div class="placement-hint" role="status">
		<button onclick={() => engine.goTo(target!.locator)}>{m['rp7.go_to_page']()}</button>
		<button disabled={saving} onclick={() => { if (canDiscard()) discard(); }}>{m['pv9.cancel']()}</button>
	</div>
{/if}
<style>
	.reflow-inserts { position: fixed; inset: 0; pointer-events: none; z-index: 15; }
	.placement-surface { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: auto; cursor: crosshair; }
	.insert { position: absolute; pointer-events: auto; }
	.content { width: 100%; height: 100%; display: block; text-align: left; }
	.content span { display: block; white-space: pre-wrap; overflow-wrap: anywhere; height: 100%; overflow: hidden; }
	.content:focus-visible { outline: 2px solid #2563eb; }
	svg { display: block; width: 100%; height: 100%; }
	.draft { background: #ffffffc9; border: 1px dashed #2563eb; }
	.draft svg { touch-action: none; }
	textarea { width: 100%; height: 100%; resize: none; color: #111827; background: transparent; padding: 3px; font-size: 18px; }
	.actions { position: absolute; top: 100%; left: 0; display: flex; flex-wrap: wrap; gap: 6px; min-width: 180px; padding: 4px; background: var(--pv-chrome, white); color: var(--shell-text); border: 1px solid #888; font-size: 13px; z-index: 1; }
	.actions button, .placement-hint button { padding: 4px; border: 1px solid #888; border-radius: 3px; }
	.actions input { max-width: 200px; }
	.placement-hint { position: fixed; bottom: 60px; left: 50%; transform: translateX(-50%); z-index: 20; padding: 8px; background: var(--pv-chrome, white); color: var(--shell-text); border: 1px solid #888; }
</style>
