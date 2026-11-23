import type { PDFDocumentProxy } from 'pdfjs-dist';

export type OutlineDestination = string | readonly unknown[] | null;

export interface OutlineNode {
	id: string;
	title: string;
	depth: number;
	page: number | null;
	offset: number;
	url: string | null;
	/** Raw PDF destination, kept so the exact offset can be resolved lazily. */
	dest?: OutlineDestination;
	children: OutlineNode[];
}

export interface FlatOutlineNode extends OutlineNode {
	parentId: string | null;
}

type PdfOutlineItem = NonNullable<Awaited<ReturnType<PDFDocumentProxy['getOutline']>>>[number];
type ResolvedDestination = { page: number | null };
type OutlineEntry = { item: PdfOutlineItem; id: string; parentId: string | null; depth: number };
type OutlineTitleNode = { title?: string | null; items?: readonly OutlineTitleNode[] | null };

const OUTLINE_CONCURRENCY = 8;
const outlineCache = new Map<string, Promise<OutlineNode[]>>();
const IMAGE_FILE_EXTENSION = /\.(?:avif|bmp|gif|heic|heif|jpe?g|jfif|png|svg|tiff?|webp)\s*$/i;
const IMAGE_LABEL = /^(?:image|img|scan(?:ned)?|photo|picture|pic|snapshot|screenshot|frame|dscn?|pxl|gopr|dji|file|document|doc|page|p|untitled)(?:[\s._#()\[\]-]*(?:(?:no|nr|number|of)\.?|#)?[\s._#()\[\]-]*\d+)*[\s._#()\[\]-]*$/i;
const CJK_IMAGE_LABEL = /^(?:图片|图像|影像|照片|扫描件?|扫描|截图)[\s._#()\[\]-]*\d*[\s._#()\[\]-]*(?:页|张)?$/;

export function outlineTitle(title: string): string {
	return title.trim().slice(0, 300).trimEnd() || 'Untitled';
}

/** Image filenames and scanner-generated labels are not a useful table of contents. */
export function isImageNameTitle(title: string | null | undefined): boolean {
	const value = title?.trim();
	if (!value) return false;
	const name = value.split(/[\\/]/).pop()?.trim() ?? value;
	return IMAGE_FILE_EXTENSION.test(name) || IMAGE_LABEL.test(name) || CJK_IMAGE_LABEL.test(name);
}

/**
 * An outline whose leaves are all image filenames is a scan artifact (one entry
 * per page), not a table of contents. Container titles are ignored so a generic
 * root such as "Scanned document" does not keep the useless list visible.
 */
export function isImageOnlyOutline(items: readonly OutlineTitleNode[]): boolean {
	let leaves = 0;
	const visit = (nodes: readonly OutlineTitleNode[]): boolean => {
		for (const node of nodes) {
			if (node.items?.length) {
				if (!visit(node.items)) return false;
			} else {
				leaves++;
				if (node.title?.trim() && !isImageNameTitle(node.title)) return false;
			}
		}
		return true;
	};
	return visit(items) && leaves > 0;
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
	// Stop before resolving destinations: a scan can list thousands of image
	// filenames, and page resolution is what makes the Contents tab hang.
	if (isImageOnlyOutline(outline)) return [];

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
		offset: 0,
		dest: item.dest,
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

/** Resolve only the page; page heights are expensive and deferred until navigation. */
async function resolveDestination(
	pdf: PDFDocumentProxy,
	value: PdfOutlineItem['dest']
): Promise<ResolvedDestination> {
	try {
		const destination = typeof value === 'string' ? await pdf.getDestination(value) : value;
		if (!Array.isArray(destination) || destination.length < 2) return { page: null };

		const pageReference = destination[0];
		const pageIndex = typeof pageReference === 'number'
			? pageReference
			: await pdf.getPageIndex(pageReference as Parameters<PDFDocumentProxy['getPageIndex']>[0]);
		if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdf.numPages) {
			return { page: null };
		}
		return { page: pageIndex + 1 };
	} catch {
		return { page: null };
	}
}

/** Resolve the precise `XYZ` offset only when a chapter is activated. */
export async function resolveOutlineOffset(
	pdf: PDFDocumentProxy,
	node: OutlineNode,
	signal?: AbortSignal
): Promise<number> {
	if (signal?.aborted) throw abortError();
	if (node.page === null || !node.dest) return 0;
	try {
		const destination = typeof node.dest === 'string' ? await pdf.getDestination(node.dest) : node.dest;
		if (signal?.aborted) throw abortError();
		if (!Array.isArray(destination) || destination.length < 2) return 0;

		const mode = destination[1];
		const top = destination[3];
		if (typeof mode !== 'object' || mode === null || !('name' in mode) || mode.name !== 'XYZ' ||
			typeof top !== 'number' || !Number.isFinite(top)) {
			return 0;
		}
		const height = (await pdf.getPage(node.page)).getViewport({ scale: 1 }).height;
		if (signal?.aborted) throw abortError();
		if (!Number.isFinite(height) || height <= 0) return 0;
		return Math.min(0.999, Math.max(0, 1 - top / height));
	} catch (error) {
		if (signal?.aborted) throw abortError();
		return 0;
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
