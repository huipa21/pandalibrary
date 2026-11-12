import { describe, expect, it, vi } from 'vitest';
import {
	createSidebarState, DOCK_QUERY, parseSidebar, SIDEBAR_KEY, type SidebarOptions
} from './sidebar-state.svelte.js';

function memory(initial?: string) {
	const values = new Map<string, string>(initial === undefined ? [] : [[SIDEBAR_KEY, initial]]);
	return {
		values,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: vi.fn((key: string, value: string) => { values.set(key, value); })
	};
}

function media(matches: boolean) {
	const listeners = new Set<(event: MediaQueryListEvent) => void>();
	const list = {
		matches,
		addEventListener: vi.fn((_: string, listener: (event: MediaQueryListEvent) => void) => { listeners.add(listener); }),
		removeEventListener: vi.fn((_: string, listener: (event: MediaQueryListEvent) => void) => { listeners.delete(listener); })
	};
	const matchMedia = vi.fn(() => list) as unknown as NonNullable<SidebarOptions['matchMedia']>;
	return { list, matchMedia, change: (next: boolean) => listeners.forEach((listener) => listener({ matches: next } as MediaQueryListEvent)) };
}

describe('sidebar state', () => {
	it('restores a supported tab when moving from PDF to a reflowable reader', () => {
		const sidebar = createSidebarState({
			storage: memory('{"open":true,"tab":"pages"}'), matchMedia: null,
			tabs: ['toc', 'annotations', 'bookmarks']
		});
		expect([sidebar.open, sidebar.tab]).toEqual([true, 'toc']);
		sidebar.show('pages');
		expect(sidebar.tab).toBe('toc');
		sidebar.toggle('bookmarks');
		expect([sidebar.open, sidebar.tab]).toEqual([true, 'bookmarks']);
	});

	it('parses stored values and falls back to collapsed on toc', () => {
		expect(parseSidebar(null)).toEqual({ open: false, tab: 'toc' });
		expect(parseSidebar('{"open":true,"tab":"pages"}')).toEqual({ open: true, tab: 'pages' });
		for (const invalid of ['nope', '[]', 'null', '{"open":"yes","tab":"pages"}', '{"open":true,"tab":"outline"}', '{"open":true}']) {
			expect(parseSidebar(invalid)).toEqual({ open: false, tab: 'toc' });
		}
	});

	it('restores and persists open and tab', () => {
		const storage = memory('{"open":true,"tab":"bookmarks"}');
		const sidebar = createSidebarState({ storage, matchMedia: null });
		expect([sidebar.open, sidebar.tab]).toEqual([true, 'bookmarks']);
		sidebar.collapse();
		expect(JSON.parse(storage.values.get(SIDEBAR_KEY)!)).toEqual({ open: false, tab: 'bookmarks' });
		sidebar.show('pages');
		expect(JSON.parse(storage.values.get(SIDEBAR_KEY)!)).toEqual({ open: true, tab: 'pages' });
		const restored = createSidebarState({ storage, matchMedia: null });
		expect([restored.open, restored.tab]).toEqual([true, 'pages']);
	});

	it('falls back to the default for an invalid stored value and survives storage errors', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const sidebar = createSidebarState({ storage: memory('{"open":1}'), matchMedia: null });
		expect([sidebar.open, sidebar.tab]).toEqual([false, 'toc']);
		const broken = createSidebarState({
			storage: { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } },
			matchMedia: null
		});
		broken.show('annotations');
		expect([broken.open, broken.tab]).toEqual([true, 'annotations']);
		expect(error).toHaveBeenCalledTimes(2);
		error.mockRestore();
	});

	it('toggle opens an inactive tab and collapses the active one', () => {
		const storage = memory();
		const sidebar = createSidebarState({ storage, matchMedia: null });
		sidebar.toggle('pages');
		expect([sidebar.open, sidebar.tab]).toEqual([true, 'pages']);
		sidebar.toggle('annotations');
		expect([sidebar.open, sidebar.tab]).toEqual([true, 'annotations']);
		sidebar.toggle('annotations');
		expect([sidebar.open, sidebar.tab]).toEqual([false, 'annotations']);
		sidebar.toggle('annotations');
		expect([sidebar.open, sidebar.tab]).toEqual([true, 'annotations']);
		expect(storage.setItem).toHaveBeenCalledTimes(4);
	});

	it('reveal routes bookmarks and everything else, and increments seq', () => {
		const sidebar = createSidebarState({ storage: memory(), matchMedia: null });
		sidebar.reveal('mark', 'a');
		expect([sidebar.open, sidebar.tab]).toEqual([true, 'annotations']);
		expect(sidebar.target).toEqual({ kind: 'mark', id: 'a', seq: 1 });
		sidebar.reveal('bookmark', 'b');
		expect(sidebar.tab).toBe('bookmarks');
		expect(sidebar.target).toEqual({ kind: 'bookmark', id: 'b', seq: 2 });
		for (const kind of ['insert', 'note'] as const) {
			sidebar.collapse();
			sidebar.reveal(kind, 'c');
			expect([sidebar.open, sidebar.tab]).toEqual([true, 'annotations']);
		}
		sidebar.reveal('note', 'c');
		expect(sidebar.target).toEqual({ kind: 'note', id: 'c', seq: 5 });
	});

	it('guards only switching away from the mounted tab', () => {
		const sidebar = createSidebarState({ storage: memory('{"open":true,"tab":"annotations"}'), matchMedia: null });
		let allow = false;
		const guard = vi.fn(() => allow);
		const unregister = sidebar.registerGuard(guard);
		sidebar.show('pages');
		sidebar.reveal('bookmark', 'b');
		expect([sidebar.tab, sidebar.target]).toEqual(['annotations', null]);
		sidebar.reveal('mark', 'a');
		sidebar.toggle('annotations');
		expect(sidebar.open).toBe(false);
		expect(guard).toHaveBeenCalledTimes(2);
		allow = true;
		sidebar.show('pages');
		expect([sidebar.open, sidebar.tab]).toEqual([true, 'pages']);
		unregister();
		allow = false;
		sidebar.show('toc');
		expect(sidebar.tab).toBe('toc');
	});

	it('derives docked from the 1024 px media query and stops listening on dispose', () => {
		const { list, matchMedia, change } = media(false);
		const sidebar = createSidebarState({ storage: memory(), matchMedia });
		expect(matchMedia).toHaveBeenCalledWith(DOCK_QUERY);
		expect(sidebar.docked).toBe(false);
		change(true);
		expect(sidebar.docked).toBe(true);
		sidebar.dispose();
		expect(list.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
		change(false);
		expect(sidebar.docked).toBe(true);
	});

});
