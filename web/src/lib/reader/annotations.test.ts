import { describe, expect, it } from 'vitest';
import {
	annotationForReader, HIGHLIGHT_COLORS, HIGHLIGHT_HEX, highlightColor, isMarkColor,
	makeHighlight, markInk, MARK_PRESETS, resolveMarkColor
} from './annotations.js';
import type { Highlight, ReaderSelection } from './types.js';

const selection: ReaderSelection = {
	text: 'A passage', fraction: 0.5, locator: { type: 'pdf', page: 2 }
};

describe('mark colours', () => {
	it('accepts legacy names and six-digit hex, and resolves invalid values only for display', () => {
		for (const color of HIGHLIGHT_COLORS) {
			expect(isMarkColor(color)).toBe(true);
			expect(resolveMarkColor(color)).toBe(HIGHLIGHT_HEX[color]);
		}
		expect(isMarkColor('#ff0000')).toBe(true);
		expect(isMarkColor('#FF0000')).toBe(true);
		expect(highlightColor('#ff0000')).toBe('#ff0000');
		expect(highlightColor('#FF0000')).toBe('#ff0000');
		expect(resolveMarkColor('#FF0000')).toBe('#ff0000');
		for (const invalid of ['', 'red', '#fff', '#12345678', '#gg0000', null, 123]) {
			expect(isMarkColor(invalid)).toBe(false);
		}
		expect(resolveMarkColor('invalid')).toBe(HIGHLIGHT_HEX.yellow);
		expect(MARK_PRESETS).toHaveLength(16);
		expect(MARK_PRESETS.every((preset) => isMarkColor(preset.value))).toBe(true);
	});

	it('uses relative luminance below 0.2 for dark-tone line ink', () => {
		expect(markInk('#000000', 'light')).toBe('#000000');
		expect(markInk('#000000', 'dark')).toBe('#e5e7eb');
		expect(markInk('#7b7b7b', 'dark')).toBe('#e5e7eb');
		expect(markInk('#7c7c7c', 'dark')).toBe('#7c7c7c');
		expect(markInk('#FFFFFF', 'dark')).toBe('#ffffff');
	});

	it('normalizes new hex values, rejects invalid writes, and keeps stored reader values', () => {
		expect(makeHighlight(1, 2, selection, '#FF0000')).toMatchObject({ data: { color: '#ff0000' } });
		expect(() => makeHighlight(1, 2, selection, 'red')).toThrow('Invalid highlight color');
		const row: Highlight = {
			id: 'one', book_id: 1, book_file_id: 2, locator: selection.locator, position: 0.5,
			text: selection.text, color: '#FF0000', chapter: null,
			created_at: '', updated_at: '', deleted_at: null, rev: 1
		};
		expect(annotationForReader(row, 2, 'pdf')?.color).toBe('#FF0000');
		expect(annotationForReader({ ...row, color: 'unknown' }, 2, 'pdf')?.color).toBe('unknown');
	});
});
