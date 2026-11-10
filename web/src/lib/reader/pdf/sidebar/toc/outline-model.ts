import type { PDFDocumentProxy } from 'pdfjs-dist';

export interface OutlineNode {
	id: string;
	title: string;
	depth: number;
	page: number | null;
	offset: number;
	url: string | null;
	children: OutlineNode[];
}

export interface FlatOutlineNode extends OutlineNode {
	parentId: string | null;
}

type PdfOutlineItem = NonNullable<Awaited<ReturnType<PDFDocumentProxy['getOutline']>>>[number];
type ResolvedDestination = { page: number | null; offset: number };
type OutlineEntry = { item: PdfOutlineItem; id: string; parentId: string | null; depth: number };

const OUTLINE_CONCURRENCY = 8;
const outlineCache = new Map<string, Promise<OutlineNode[]>>();

export function outlineTitle(title: string): string {
	return title.trim().slice(0, 300).trimEnd() || 'Untitled';
}

export function safeOutlineUrl(value: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? value : null;
	} catch {
		return null;
	}
}

export function flattenOutline(nodes: readonly OutlineNode[]): FlatOutlineNode[] {
	const flat: FlatOutlineNode[] = [];
	const visit = (items: readonly OutlineNode[], parentId: string | null) => {
		for (const node of items) {
			flat.push({ ...node, parentId });
			visit(node.children, node.id);
		}
	};
	visit(nodes, null);
	return flat;
}

export function currentNode(
	flat: readonly OutlineNode[],
	page: number,
	offset: number
): OutlineNode | null {
	let current: OutlineNode | null = null;
	for (const node of flat) {
		if (node.page === null || node.page > page || (node.page === page && node.offset > offset)) continue;
		if (!current || node.page > current.page! ||
			(node.page === current.page && node.offset > current.offset) ||
			(node.page === current.page && node.offset === current.offset && node.depth > current.depth)) {
			current = node;
		}
	}
	return current;
}

export async function loadOutline(pdf: PDFDocumentProxy, signal?: AbortSignal): Promise<OutlineNode[]> {
	if (signal?.aborted) throw abortError();
	const fingerprint = pdf.fingerprints[0];
	if (!fingerprint) throw new Error('The PDF document has no fingerprint.');

	let pending = outlineCache.get(fingerprint);
	if (!pending) {
		pending = buildOutline(pdf);
		outlineCache.set(fingerprint, pending);
		pending.catch(() => {
			if (outlineCache.get(fingerprint) === pending) outlineCache.delete(fingerprint);
		});
	}
	return waitForAbort(pending, signal);
}

async function buildOutline(pdf: PDFDocumentProxy): Promise<OutlineNode[]> {
	const outline = await pdf.getOutline();
	if (!outline?.length) return [];

	const entries: OutlineEntry[] = [];
	const collect = (items: readonly PdfOutlineItem[], parentId: string | null, prefix: string, depth: number) => {
		items.forEach((item, index) => {
			const id = prefix ? `${prefix}.${index}` : String(index);
			entries.push({ item, id, parentId, depth });
			collect(item.items, id, id, depth + 1);
		});
	};
	collect(outline, null, '', 0);

	const resolved: ResolvedDestination[] = new Array(entries.length);
	let next = 0;
	const resolveNext = async () => {
		while (next < entries.length) {
			const index = next++;
			resolved[index] = await resolveDestination(pdf, entries[index].item.dest);
		}
	};
	await Promise.all(Array.from(
		{ length: Math.min(OUTLINE_CONCURRENCY, entries.length) },
		() => resolveNext()
	));

	const nodes = entries.map(({ item, id, parentId, depth }, index) => ({
		id,
		title: outlineTitle(item.title),
		depth,
		...resolved[index],
		url: safeOutlineUrl(item.url),
		children: [] as OutlineNode[],
		parentId
	}));
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const roots: OutlineNode[] = [];
	for (const node of nodes) {
		if (node.parentId === null) roots.push(node);
		else byId.get(node.parentId)?.children.push(node);
	}
	return roots;
}

async function resolveDestination(
	pdf: PDFDocumentProxy,
	value: PdfOutlineItem['dest']
): Promise<ResolvedDestination> {
	try {
		const destination = typeof value === 'string' ? await pdf.getDestination(value) : value;
		if (!Array.isArray(destination) || destination.length < 2) return { page: null, offset: 0 };

		const pageReference = destination[0];
		const pageIndex = typeof pageReference === 'number'
			? pageReference
			: await pdf.getPageIndex(pageReference);
		if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdf.numPages) {
			return { page: null, offset: 0 };
		}
		const page = pageIndex + 1;
		const mode = destination[1];
		const top = destination[3];
		if (typeof mode !== 'object' || mode === null || !('name' in mode) || mode.name !== 'XYZ' ||
			typeof top !== 'number' || !Number.isFinite(top)) {
			return { page, offset: 0 };
		}
		const height = (await pdf.getPage(page)).getViewport({ scale: 1 }).height;
		if (!Number.isFinite(height) || height <= 0) return { page, offset: 0 };
		return { page, offset: Math.min(0.999, Math.max(0, 1 - top / height)) };
	} catch {
		return { page: null, offset: 0 };
	}
}

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener('abort', onAbort);
			reject(abortError());
		};
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort);
				reject(error);
			}
		);
	});
}

function abortError(): DOMException {
	return new DOMException('The operation was aborted.', 'AbortError');
}
