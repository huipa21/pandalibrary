import { describe, expect, it } from 'vitest';
import en from '../../../messages/en.json';
import zh from '../../../messages/zh.json';
import { addableShelves } from './addable.js';
import { removedRuleGroups, shelfRuleGroups, validRuleGroups } from './rules.js';
import type { RuleGroup, Shelf } from './types.js';

const group = (id = 'a'): RuleGroup => ({
	id, name: 'Fiction', rules: { match: 'all', conditions: [{ field: 'title', op: 'contains', value: 'Novel' }] }
});

describe('independent collection rules', () => {
	it('accepts mixed all/any groups and numeric identifiers while rejecting malformed conditions', () => {
		const first = group();
		const second: RuleGroup = { id: 'b', name: 'Authors', rules: { match: 'any', conditions: [
			{ field: 'author_id', op: 'eq', value: 12 }, { field: 'language', op: 'eq', value: 'zh-Hans' }
		] } };
		expect(validRuleGroups([first, second])).toBe(true);
		expect(validRuleGroups([])).toBe(true);
		for (const condition of [
			{ field: 'author_id', op: 'eq', value: '12' },
			{ field: 'author_id', op: 'eq', value: -1 },
			{ field: 'title', op: 'eq', value: 'Novel' },
			{ field: 'format', op: 'eq', value: 'docx' },
			{ field: 'reading_status', op: 'eq', value: 'invalid' },
			{ field: 'language', op: 'eq', value: 'invalid tag' }
		]) expect(validRuleGroups([{ ...first, rules: { match: 'all', conditions: [condition] } }])).toBe(false);
	});

	it('requires valid unique stable IDs, names and at least one condition per group', () => {
		expect(validRuleGroups([group(), group()])).toBe(false);
		expect(validRuleGroups([{ ...group(), id: '../bad' }])).toBe(false);
		expect(validRuleGroups([{ ...group(), name: ' ' }])).toBe(false);
		expect(validRuleGroups([{ ...group(), rules: { match: 'all', conditions: [] } }])).toBe(false);
	});

	it('upgrades legacy rules without mutation, and distinguishes edits from deletions', () => {
		const rules = group().rules;
		const migrated = shelfRuleGroups({ rules });
		expect(migrated[0].id).toBe('legacy');
		migrated[0].rules.conditions[0].value = 'changed';
		expect(rules.conditions[0].value).toBe('Novel');
		expect(shelfRuleGroups({ rules, rule_groups: [] })).toEqual([]);
		expect(removedRuleGroups([group()], [{ ...group(), name: 'Renamed' }])).toBe(false);
		expect(removedRuleGroups([group()], [])).toBe(true);
	});

	it('offers manual membership for legacy automatic and mixed collections, not uncollected or inaccessible ones', () => {
		const base = { id: 1, kind: 'private', owner_id: 1, mode: 'automatic' } as Shelf;
		const all = [base, { ...base, id: 2, rule_groups: [group()] }, { ...base, id: 3, owner_id: 2 },
			{ ...base, id: 4, system_key: 'unshelved' }];
		expect(addableShelves(all, { id: 1, role: 'user', username: 'reader', display_name: 'Reader' }).map((s) => s.id)).toEqual([1, 2]);
		expect(addableShelves(all, null)).toEqual([]);
	});

	it('localizes rule controls and replaces shelf terminology without changing interpolation arguments', () => {
		const keys = Object.keys(en).filter((key) => key.startsWith('collections.'));
		expect(keys.length).toBeGreaterThan(10);
		for (const key of keys) expect(zh).toHaveProperty([key]);
		expect(en['shelves.title']).toBe('Collections');
		expect(zh['shelves.title']).toBe('合集');
		expect(en['bd5.remove_confirm']).toContain('{shelf}');
		expect(Object.values(en).some((value) => /\bshel(?:f|ves)\b/i.test(value.replace(/\{[^}]+\}/g, '')))).toBe(false);
		expect(Object.values(zh).some((value) => value.includes('书架'))).toBe(false);
	});
});
