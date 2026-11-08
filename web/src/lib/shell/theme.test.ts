import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, initialTheme, readTheme, saveTheme } from './theme.js';

describe('initialTheme', () => {
	it('uses a valid saved choice before the media preference', () => {
		expect(initialTheme('light', true)).toBe('light');
		expect(initialTheme('dark', false)).toBe('dark');
	});

	it('uses the media preference for missing or invalid values', () => {
		expect(initialTheme(null, true)).toBe('dark');
		expect(initialTheme('sepia', false)).toBe('light');
	});
});

describe('theme persistence and application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('reads and applies the saved theme', () => {
		const meta = { content: '#fff' };
		const root = { dataset: {} as DOMStringMap, style: { colorScheme: '' } };
		vi.stubGlobal('window', {
			localStorage: { getItem: () => 'dark' },
			matchMedia: () => ({ matches: false })
		});
		vi.stubGlobal('document', { documentElement: root, querySelector: () => meta });
		expect(readTheme()).toBe('dark');
		applyTheme('dark');
		expect(root.dataset.theme).toBe('dark');
		expect(root.style.colorScheme).toBe('dark');
		expect(meta.content).toBe('#191c1f');
	});

	it('does not throw when local storage is unavailable', () => {
		vi.stubGlobal('window', {
			localStorage: {
				getItem: () => {
					throw new Error('blocked');
				},
				setItem: () => {
					throw new Error('blocked');
				}
			},
			matchMedia: () => ({ matches: false })
		});
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		expect(readTheme()).toBe('light');
		expect(() => saveTheme('dark')).not.toThrow();
	});
});
