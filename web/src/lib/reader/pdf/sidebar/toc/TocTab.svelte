<script lang="ts">
	import { tick } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getPdfReaderContext } from '../../context.js';
	import { currentNode, flattenOutline, loadOutline, type FlatOutlineNode, type OutlineNode } from './outline-model.js';

	const ctx = getPdfReaderContext();
	let root = $state<HTMLDivElement>();
	let nodes = $state<OutlineNode[]>([]);
	let expanded = $state<Set<string>>(new Set());
	let focusedId = $state<string | null>(null);
	let loading = $state(true);
	let failed = $state(false);
	let retry = $state(0);
	let lastUserScrollAt = 0;
	const flat = $derived(flattenOutline(nodes));
	const current = $derived(currentNode(flat, ctx.view.page, ctx.view.offset));
	const currentId = $derived(current?.id ?? null);
	const visible = $derived(visibleNodes(nodes, expanded));

	$effect(() => {
		const attempt = retry;
		const pdf = ctx.engine.pdf;
		if (!pdf) {
			nodes = [];
			loading = true;
			failed = false;
			return;
		}

		const controller = new AbortController();
		loading = true;
		failed = false;
		void loadOutline(pdf, controller.signal).then((result) => {
			if (controller.signal.aborted) return;
			nodes = result;
			expanded = new Set(result.filter((node) => node.children.length).map((node) => node.id));
			focusedId = result[0]?.id ?? null;
		}).catch((error: unknown) => {
			if (controller.signal.aborted) return;
			console.error('Could not load the PDF outline', error);
			failed = true;
		}).finally(() => {
			if (!controller.signal.aborted) loading = false;
		});
		return () => controller.abort();
	});

	$effect(() => {
		const id = currentId;
		if (!id) return;
		const entry = flat.find((node) => node.id === id);
		if (!entry || entry.depth === 0) return;
		const ancestors = flat.filter((node) => node.depth < entry.depth && id.startsWith(`${node.id}.`));
		const next = new Set(expanded);
		for (const ancestor of ancestors) next.add(ancestor.id);
		if (next.size !== expanded.size) expanded = next;
	});

	$effect(() => {
		const id = currentId;
		if (!id) return;
		void tick().then(() => {
			if (!root || id !== currentId || Date.now() - lastUserScrollAt < 2000) return;
			root.querySelector<HTMLElement>(`[data-toc-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
		});
	});

	function visibleNodes(tree: readonly OutlineNode[], open: ReadonlySet<string>, parentId: string | null = null): FlatOutlineNode[] {
		const result: FlatOutlineNode[] = [];
		for (const node of tree) {
			result.push({ ...node, parentId });
			if (open.has(node.id)) result.push(...visibleNodes(node.children, open, node.id));
		}
		return result;
	}

	function moveFocus(id: string | null) {
		if (!id) return;
		focusedId = id;
		void tick().then(() => root?.querySelector<HTMLElement>(`[data-toc-id="${id}"]`)?.focus());
	}

	function setExpanded(id: string, value: boolean) {
		const next = new Set(expanded);
		if (value) next.add(id);
		else next.delete(id);
		expanded = next;
	}

	function closeOverlay() {
		if (!ctx.sidebar.docked) ctx.sidebar.collapse();
	}

	function activate(node: OutlineNode) {
		if (node.url) {
			closeOverlay();
			return;
		}
		if (node.page === null) return;
		closeOverlay();
		void ctx.engine.goToPage(node.page, node.offset).catch((error: unknown) => {
			console.error('Could not navigate to the PDF outline destination', error);
			ctx.announce(m['rp5.navigation_error']());
		});
	}

	function onkeydown(event: KeyboardEvent, node: FlatOutlineNode) {
		const index = visible.findIndex((entry) => entry.id === node.id);
		const parent = node.parentId ? visible.find((entry) => entry.id === node.parentId) : undefined;
		const firstChild = node.children[0];
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				moveFocus(visible[index + 1]?.id ?? null);
				break;
			case 'ArrowUp':
				event.preventDefault();
				moveFocus(visible[index - 1]?.id ?? null);
				break;
			case 'ArrowRight':
				event.preventDefault();
				if (node.children.length && !expanded.has(node.id)) setExpanded(node.id, true);
				else if (firstChild) moveFocus(firstChild.id);
				break;
			case 'ArrowLeft':
				event.preventDefault();
				if (node.children.length && expanded.has(node.id)) setExpanded(node.id, false);
				else moveFocus(parent?.id ?? null);
				break;
			case 'Enter':
				if (node.url) return;
				event.preventDefault();
				activate(node);
				break;
		}
	}

	function noteUserScroll() {
		lastUserScrollAt = Date.now();
	}

	function noteScrollbarDrag(event: PointerEvent) {
		if (!root) return;
		const bounds = root.getBoundingClientRect();
		const scrollbarWidth = root.offsetWidth - root.clientWidth;
		if (scrollbarWidth > 0 && event.clientX >= bounds.right - scrollbarWidth) noteUserScroll();
	}
</script>

<div
	bind:this={root}
	class="min-h-0 flex-1 overflow-y-auto p-2"
	role={!loading && !failed && nodes.length > 0 ? 'tree' : 'region'}
	aria-label={m['rp5.tree']()}
	aria-busy={loading}
	tabindex="-1"
	onwheel={noteUserScroll}
	ontouchstart={noteUserScroll}
	onpointerdown={noteScrollbarDrag}
>
	{#if loading}
		<div class="space-y-1 p-1" aria-label={m['rp5.loading']()} aria-hidden="true">
			{#each [0, 1, 2] as row (row)}
				<div class="h-7 animate-pulse rounded bg-[var(--shell-border)]"></div>
			{/each}
		</div>
	{:else if failed}
		<div class="flex flex-col items-start gap-3 p-3" role="alert">
			<p>{m['rp5.error']()}</p>
			<button class="rounded border border-[var(--shell-border)] px-3 py-1.5" type="button" onclick={() => retry++}>
				{m['rp5.retry']()}
			</button>
		</div>
	{:else if nodes.length === 0}
		<p class="p-3 text-sm text-[var(--shell-muted)]">{m['rp5.empty']()}</p>
	{:else}
		{#each visible as node (node.id)}
			{#if node.url}
				<a
					class="flex h-7 min-w-0 items-center gap-2 border-l-2 px-2 text-sm hover:bg-[var(--shell-hover)] {currentId === node.id ? 'border-emerald-500 text-emerald-700 dark:text-emerald-300' : 'border-transparent'}"
					style={`padding-left: ${node.depth * 12}px`}
					data-toc-id={node.id}
					role="treeitem"
					aria-level={node.depth + 1}
					aria-expanded={expanded.has(node.id)}
					aria-selected="false"
					aria-current={currentId === node.id ? 'location' : undefined}
					tabindex={focusedId === node.id ? 0 : -1}
					title={node.title}
					href={node.url}
					target="_blank"
					rel="noopener noreferrer"
					onfocus={() => { focusedId = node.id; }}
					onclick={() => activate(node)}
					onkeydown={(event) => onkeydown(event, node)}
				>
					<span class="min-w-0 flex-1 truncate">{node.title}</span>
					{#if node.page !== null}<span class="shrink-0 text-[var(--shell-muted)] tabular-nums">{node.page}</span>{/if}
				</a>
			{:else}
				<div
					class="flex h-7 min-w-0 items-center gap-2 border-l-2 px-2 text-sm {currentId === node.id ? 'border-emerald-500 text-emerald-700 dark:text-emerald-300' : 'border-transparent'} {node.page === null ? 'cursor-default text-[var(--shell-muted)]' : 'cursor-pointer hover:bg-[var(--shell-hover)]'}"
					style={`padding-left: ${node.depth * 12}px`}
					data-toc-id={node.id}
					role="treeitem"
					aria-level={node.depth + 1}
					aria-expanded={expanded.has(node.id)}
					aria-selected="false"
					aria-current={currentId === node.id ? 'location' : undefined}
					aria-disabled={node.page === null}
					tabindex={focusedId === node.id ? 0 : -1}
					title={node.title}
					onfocus={() => { focusedId = node.id; }}
					onclick={() => {
						moveFocus(node.id);
						activate(node);
					}}
					onkeydown={(event) => onkeydown(event, node)}
				>
					<span class="w-3 shrink-0 text-center" aria-hidden="true">{node.children.length ? expanded.has(node.id) ? '▾' : '▸' : ''}</span>
					<span class="min-w-0 flex-1 truncate">{node.title}</span>
					{#if node.page !== null}<span class="shrink-0 text-[var(--shell-muted)] tabular-nums">{node.page}</span>{/if}
				</div>
			{/if}
		{/each}
	{/if}
</div>
