import { describe, expect, it } from 'vitest';
import { BACKGROUNDS, backgroundFor, isBackgroundId, themeFor, withBackground } from './appearance.js';
import { DEFAULT_SETTINGS } from './settings.js';

describe('reader appearance presets', () => {
	it('defines the specified backgrounds in order with valid colors and wood grain', () => {
		expect(BACKGROUNDS.map(({ id, page, text, tone }) => [id, page, text, tone])).toEqual([
			['white', '#ffffff', '#1f2937', 'light'],
			['cream', '#faf6ec', '#2b2b2b', 'light'],
			['sepia', '#f4ecd8', '#5b4636', 'light'],
			['green', '#c7edcc', '#1f3a24', 'light'],
			['wood', '#dcc29b', '#3e2c1c', 'light'],
			['gray', '#e6e6e6', '#262626', 'light'],
			['blue', '#dce8f5', '#1e2a3a', 'light'],
			['pink', '#f9e3e3', '#3f2a2a', 'light'],
			['night', '#1c1c1e', '#c8c8c8', 'dark'],
			['black', '#000000', '#a3a3a3', 'dark']
		]);
		for (const preset of BACKGROUNDS) {
			expect(preset.page).toMatch(/^#[\da-f]{6}$/i);
			expect(preset.text).toMatch(/^#[\da-f]{6}$/i);
			expect(isBackgroundId(preset.id)).toBe(true);
			if (preset.id === 'wood') {
				expect(preset.grain).toBe('repeating-linear-gradient(90deg, rgb(0 0 0 / 3%) 0 2px, transparent 2px 7px)');
			} else expect(preset.grain).toBeUndefined();
		}
		for (const value of ['White', '', 'unknown', null, 0, {}, []]) {
			expect(isBackgroundId(value)).toBe(false);
		}
	});

	it('derives old settings from their themes unless a background is set', () => {
		expect(DEFAULT_SETTINGS).not.toHaveProperty('background');
		expect(backgroundFor({ ...DEFAULT_SETTINGS, theme: 'light' }).id).toBe('white');
		expect(backgroundFor({ ...DEFAULT_SETTINGS, theme: 'sepia' }).id).toBe('sepia');
		expect(backgroundFor({ ...DEFAULT_SETTINGS, theme: 'dark' }).id).toBe('night');
		for (const preset of BACKGROUNDS) {
			expect(backgroundFor({ ...DEFAULT_SETTINGS, theme: 'dark', background: preset.id })).toBe(preset);
		}
	});

	it('keeps the legacy theme synchronized without mutating settings', () => {
		const expected = {
			white: 'light', cream: 'sepia', sepia: 'sepia', green: 'light', wood: 'sepia',
			gray: 'light', blue: 'light', pink: 'light', night: 'dark', black: 'dark'
		};
		for (const preset of BACKGROUNDS) {
			const initial = { ...DEFAULT_SETTINGS, size: 130 };
			const result = withBackground(initial, preset.id);
			expect(themeFor(preset.id)).toBe(expected[preset.id]);
			expect(result).toEqual({ ...initial, background: preset.id, theme: expected[preset.id] });
			expect(initial).not.toHaveProperty('background');
		}
	});
});
