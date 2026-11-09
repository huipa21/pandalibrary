import { describe, expect, it } from 'vitest';
import { viewKey } from './view-keys.js';

const key = (key: string, modifiers: Partial<KeyboardEvent> = {}) => ({
	key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers
});

describe('PDF view keys', () => {
	it.each(['ArrowLeft', 'PageUp'])('maps %s to previous', (value) => {
		expect(viewKey(key(value))).toEqual({ type: 'turn', direction: -1 });
	});
	it.each(['ArrowRight', 'PageDown', ' '])('maps %s to next', (value) => {
		expect(viewKey(key(value))).toEqual({ type: 'turn', direction: 1 });
	});
	it('maps shifted Space, page bounds and tool keys', () => {
		expect(viewKey(key(' ', { shiftKey: true }))).toEqual({ type: 'turn', direction: -1 });
		expect(viewKey(key('Home'))).toEqual({ type: 'page', end: false });
		expect(viewKey(key('End'))).toEqual({ type: 'page', end: true });
		for (const [value, tool] of [['V', 'select'], ['h', 'hand'], ['I', 'insert']]) {
			expect(viewKey(key(value))).toEqual({ type: 'tool', tool });
		}
	});
	it('maps rotation, zoom and Escape', () => {
		expect(viewKey(key('r'))).toEqual({ type: 'rotate', delta: 90 });
		expect(viewKey(key('R', { shiftKey: true }))).toEqual({ type: 'rotate', delta: -90 });
		for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
			expect(viewKey(key('=', modifier))).toEqual({ type: 'zoom', direction: 1 });
			expect(viewKey(key('+', modifier))).toEqual({ type: 'zoom', direction: 1 });
			expect(viewKey(key('-', modifier))).toEqual({ type: 'zoom', direction: -1 });
			expect(viewKey(key('0', modifier))).toEqual({ type: 'zoom', direction: 0 });
		}
		expect(viewKey(key('Escape'))).toEqual({ type: 'escape' });
	});
	it('ignores editable focus, menus, unrelated modifiers and unbound keys', () => {
		for (const value of ['r', ' ', 'End', 'Escape']) {
			expect(viewKey(key(value), true)).toBeNull();
			expect(viewKey(key(value), false, true)).toBeNull();
		}
		expect(viewKey(key('r', { altKey: true }))).toBeNull();
		expect(viewKey(key('r', { ctrlKey: true }))).toBeNull();
		expect(viewKey(key('ArrowRight', { shiftKey: true }))).toBeNull();
		expect(viewKey(key('x'))).toBeNull();
	});
});
