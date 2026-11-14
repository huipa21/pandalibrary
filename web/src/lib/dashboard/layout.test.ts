import en from '../../../messages/en.json';
import zh from '../../../messages/zh.json';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '#lib/api/client.js';
import type { Setting } from '#lib/reader/types.js';
import {
	DEFAULT_SECTIONS, LayoutTooLargeError, layoutValue, moveSection, moveSectionTo, parseLayout, parseSectionId, shelfSection
} from './layout.js';

const setting = (value: JsonValue): Setting => ({
	key: 'dashboard.layout.v1', value, updated_at: '2026-11-04T00:00:00Z', rev: 1
});

describe('dashboard layout', () => {
	it('uses defaults only for a missing setting and preserves a saved empty array', () => {
		expect(parseLayout(undefined)).toEqual({ valid: true, sections: DEFAULT_SECTIONS, missing: true });
		expect(parseLayout(setting({ version: 1, sections: [] }))).toEqual({
			valid: true, sections: [], missing: false
		});
		expect(layoutValue([])).toEqual({ version: 1, sections: [] });
	});

	it('rejects invalid versions, shapes, unknown IDs, unsafe shelf IDs and duplicates', () => {
		const invalid: JsonValue[] = [
			null,
			{ version: 2, sections: [] },
			{ version: 1 },
			{ version: 1, sections: [null] },
			{ version: 1, sections: [{ id: 'shelf:0' }] },
			{ version: 1, sections: [{ id: 'shelf:01' }] },
			{ version: 1, sections: [{ id: 'shelf:9007199254740992' }] },
			{ version: 1, sections: [{ id: 'unshelved' }] },
			{ version: 1, sections: [{ id: 'read' }, { id: 'read' }] }
		];
		for (const value of invalid) {
			expect(parseLayout(setting(value))).toEqual({ valid: false });
		}
		expect(parseSectionId('shelf:42')).toBe('shelf:42');
		expect(() => shelfSection(-1)).toThrow('Invalid shelf');
	});

	it('serializes the exact synced shape and reorders without mutating the source', () => {
		const original = ['continue_reading', 'recently_added', 'read'] as const;
		const moved = moveSection(original, 'read', -1);
		expect(moved).toEqual(['continue_reading', 'read', 'recently_added']);
		expect(original).toEqual(DEFAULT_SECTIONS);
		expect(moveSection(moved, 'continue_reading', -1)).toEqual(moved);
		expect(layoutValue([...moved, shelfSection(42)])).toEqual({
			version: 1,
			sections: [
				{ id: 'continue_reading' }, { id: 'read' }, { id: 'recently_added' }, { id: 'shelf:42' }
			]
		});
		expect(() => layoutValue(['read', 'read'])).toThrow('Invalid dashboard sections');
	});

	it('moves a dragged section to a clamped target index', () => {
		const original = ['continue_reading', 'recently_added', 'read'] as const;
		expect(moveSectionTo(original, 'continue_reading', 2)).toEqual(['recently_added', 'read', 'continue_reading']);
		expect(moveSectionTo(original, 'read', -5)).toEqual(['read', 'continue_reading', 'recently_added']);
		expect(moveSectionTo(original, 'unread', 0)).toEqual([...original]);
		expect(original).toEqual(DEFAULT_SECTIONS);
	});

	it('checks the actual encoded settings limit before saving', () => {
		const sections = Array.from({ length: 4000 }, (_, index) => shelfSection(index + 1));
		expect(() => layoutValue(sections)).toThrow(LayoutTooLargeError);
	});

	it('provides every dashboard message in both locales', () => {
		const keys = (messages: object) => Object.keys(messages).filter((key) => key.startsWith('ux5.')).sort();
		expect(keys(en).length).toBeGreaterThan(30);
		expect(keys(zh)).toEqual(keys(en));
	});
});
