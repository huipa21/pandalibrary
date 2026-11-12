export const SIDEBAR_TABS = ['toc', 'pages', 'annotations', 'bookmarks'] as const;
export type SidebarTab = (typeof SIDEBAR_TABS)[number];
export type RevealKind = 'mark' | 'bookmark' | 'insert' | 'note';
export interface SidebarTarget { readonly kind: RevealKind; readonly id: string; readonly seq: number }

export const SIDEBAR_KEY = 'pandalibrary.reader-sidebar';
export const DOCK_QUERY = '(min-width: 1024px)';
export const RAIL_WIDTH = 44;
export const PANEL_WIDTH = 300;

export interface SidebarState {
	readonly open: boolean;
	readonly tab: SidebarTab;
	readonly docked: boolean;
	readonly target: SidebarTarget | null;
	show(tab: SidebarTab): void;
	collapse(): void;
	toggle(tab: SidebarTab): void;
	reveal(kind: RevealKind, id: string): void;
	/** Tab content registers a guard that may veto unmounting it (for example to keep an unsaved draft). */
	registerGuard(guard: () => boolean): () => void;
	dispose(): void;
}

interface Persisted { open: boolean; tab: SidebarTab }
const DEFAULT: Persisted = { open: false, tab: 'toc' };

export function isSidebarTab(value: unknown): value is SidebarTab {
	return typeof value === 'string' && (SIDEBAR_TABS as readonly string[]).includes(value);
}

/** Parses the stored `{open, tab}`; anything invalid falls back to collapsed on `toc`. */
export function parseSidebar(raw: string | null): Persisted {
	if (!raw) return { ...DEFAULT };
	try {
		const value: unknown = JSON.parse(raw);
		if (value && typeof value === 'object') {
			const { open, tab } = value as Record<string, unknown>;
			if (typeof open === 'boolean' && isSidebarTab(tab)) return { open, tab };
		}
	} catch {
		// Invalid JSON falls through to the default.
	}
	return { ...DEFAULT };
}

type MediaList = Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;
export interface SidebarOptions {
	tabs?: readonly SidebarTab[];
	storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
	matchMedia?: ((query: string) => MediaList) | null;
}

function defaultStorage(): SidebarOptions['storage'] {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

export function createSidebarState(options: SidebarOptions = {}): SidebarState {
	const storage = options.storage === undefined ? defaultStorage() : options.storage;
	const match = options.matchMedia === undefined
		? (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia.bind(window) : null)
		: options.matchMedia;
	let initial: Persisted = { ...DEFAULT };
	try {
		initial = parseSidebar(storage?.getItem(SIDEBAR_KEY) ?? null);
	} catch (error) {
		console.error('Could not restore the reader sidebar', error);
	}
	const tabs = options.tabs ?? SIDEBAR_TABS;
	if (!tabs.includes(initial.tab)) initial.tab = tabs[0] ?? 'toc';
	let open = $state(initial.open);
	let tab = $state<SidebarTab>(initial.tab);
	let target = $state<SidebarTarget | null>(null);
	const media = match?.(DOCK_QUERY) ?? null;
	let docked = $state(media?.matches ?? true);
	const onMedia = (event: MediaQueryListEvent) => { docked = event.matches; };
	media?.addEventListener('change', onMedia);
	const guards = new Set<() => boolean>();
	let seq = 0;

	function persist() {
		try {
			storage?.setItem(SIDEBAR_KEY, JSON.stringify({ open, tab }));
		} catch (error) {
			console.error('Could not save the reader sidebar', error);
		}
	}

	/** Switching away from the mounted tab unmounts it; collapsing only hides it. */
	function canSwitch(next: SidebarTab) {
		return next === tab || [...guards].every((guard) => guard());
	}

	function set(nextOpen: boolean, nextTab: SidebarTab) {
		if (nextOpen === open && nextTab === tab) return;
		open = nextOpen;
		tab = nextTab;
		persist();
	}

	function show(next: SidebarTab) {
		if (!tabs.includes(next) || !canSwitch(next)) return;
		set(true, next);
	}

	return {
		get open() { return open; },
		get tab() { return tab; },
		get docked() { return docked; },
		get target() { return target; },
		show,
		collapse: () => set(false, tab),
		toggle(next) {
			if (open && tab === next) set(false, tab);
			else show(next);
		},
		reveal(kind, id) {
			const next: SidebarTab = kind === 'bookmark' ? 'bookmarks' : 'annotations';
			if (!canSwitch(next)) return;
			set(true, next);
			target = { kind, id, seq: ++seq };
		},
		registerGuard(guard) {
			guards.add(guard);
			return () => { guards.delete(guard); };
		},
		dispose() {
			media?.removeEventListener('change', onMedia);
			guards.clear();
		}
	};
}
