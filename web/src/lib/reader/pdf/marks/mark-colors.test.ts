import { describe, expect, it, vi } from 'vitest';
import { MarkColors } from './mark-colors.svelte.js';

function storage(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => { values.set(key, value); }
	};
}

describe('mark colour preferences', () => {
	it('defaults to yellow highlights and shared black lines', () => {
		const colors = new MarkColors(() => storage());
		expect(colors.get('highlight')).toBe('yellow');
		expect(colors.get('underline')).toBe('#000000');
		expect(colors.get('strikeout')).toBe('#000000');
		expect(colors.custom).toBeNull();
	});

	it('persists each family and the custom slot independently', () => {
		const store = storage();
		const colors = new MarkColors(() => store);
		colors.set('highlight', 'purple');
		colors.set('underline', '#FF0011');
		colors.setCustom('#AABBCC');
		const restored = new MarkColors(() => store);
		expect(restored.get('highlight')).toBe('purple');
		expect(restored.get('strikeout')).toBe('#ff0011');
		expect(restored.custom).toBe('#aabbcc');
		expect(() => colors.set('highlight', 'invalid')).toThrow();
		expect(() => colors.setCustom('yellow')).toThrow();
	});

	it('falls back for invalid stored values without accepting them', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const colors = new MarkColors(() => storage({
				'pandalibrary.mark-color.highlight': '#fff',
				'pandalibrary.mark-color.line': 'black',
				'pandalibrary.mark-color.custom': 'yellow'
			}));
			expect(colors.get('highlight')).toBe('yellow');
			expect(colors.get('underline')).toBe('#000000');
			expect(colors.custom).toBeNull();
			expect(warn).toHaveBeenCalledTimes(3);
		} finally {
			warn.mockRestore();
		}
	});

	it('reports unavailable storage while keeping session colours', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const colors = new MarkColors(() => { throw new Error('Storage blocked'); });
			expect(colors.storageError).toBe(true);
			colors.set('highlight', 'blue');
			expect(colors.get('highlight')).toBe('blue');
			expect(colors.storageError).toBe(true);
			expect(error).toHaveBeenCalled();
		} finally {
			error.mockRestore();
		}
	});
});
