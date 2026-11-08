export const BROWSE_CONTEXT_KEY = 'pandalibrary.browse-context';
export const MAX_BROWSE_IDS = 5000;

export interface BrowseContextInput {
	ids: readonly number[];
	label: string;
	href: string;
}

export interface BrowseContext {
	ids: number[];
	label: string;
	href: string;
}

export interface BrowseNeighbors {
	/** 1-based position of the book in the remembered list. */
	index: number;
	total: number;
	previousId: number | null;
	nextId: number | null;
	label: string;
	href: string;
}

function storage(): Storage | null {
	try {
		return globalThis.sessionStorage ?? null;
	} catch {
		return null;
	}
}

function validID(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Only same-origin absolute paths are kept so the Back fallback cannot leave the app. */
export function safeHref(value: unknown): string | null {
	if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
	return value;
}

function uniqueIDs(values: readonly unknown[]): number[] {
	const seen = new Set<number>();
	const ids: number[] = [];
	for (const value of values) {
		if (!validID(value) || seen.has(value)) continue;
		seen.add(value);
		ids.push(value);
		if (ids.length >= MAX_BROWSE_IDS) break;
	}
	return ids;
}

export function rememberBrowseContext({ ids, label, href }: BrowseContextInput): void {
	const target = storage();
	const origin = safeHref(href);
	if (!target || origin === null) return;
	const context: BrowseContext = { ids: uniqueIDs(ids), label: String(label), href: origin };
	try {
		target.setItem(BROWSE_CONTEXT_KEY, JSON.stringify(context));
	} catch {
		// Quota and privacy-mode failures only disable previous/next navigation.
	}
}

export function readBrowseContext(): BrowseContext | null {
	const source = storage();
	if (!source) return null;
	let raw: string | null;
	try {
		raw = source.getItem(BROWSE_CONTEXT_KEY);
	} catch {
		return null;
	}
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return null;
		const value = parsed as Record<string, unknown>;
		const href = safeHref(value.href);
		if (!Array.isArray(value.ids) || href === null) return null;
		return {
			ids: uniqueIDs(value.ids),
			label: typeof value.label === 'string' ? value.label : '',
			href
		};
	} catch {
		return null;
	}
}

/** Neighbors of `bookId` in the remembered list; null when `originHref` is given and the list came from elsewhere. */
export function browseNeighbors(bookId: number, originHref?: string): BrowseNeighbors | null {
	if (!validID(bookId)) return null;
	const context = readBrowseContext();
	if (!context) return null;
	if (originHref !== undefined && context.href !== originHref) return null;
	const position = context.ids.indexOf(bookId);
	if (position < 0) return null;
	return {
		index: position + 1,
		total: context.ids.length,
		previousId: position > 0 ? context.ids[position - 1] : null,
		nextId: position < context.ids.length - 1 ? context.ids[position + 1] : null,
		label: context.label,
		href: context.href
	};
}
