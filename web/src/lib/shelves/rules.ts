import type { RuleGroup, Shelf } from './types.js';

export const RULE_FIELDS = ['title', 'author_id', 'series_id', 'tag_id', 'language', 'format', 'reading_status'] as const;
export const RULE_FORMATS = ['epub', 'pdf', 'mobi', 'azw3', 'fb2', 'fbz', 'cbz'];
export const RULE_STATUSES = ['unread', 'want_to_read', 'reading', 'on_hold', 'rereading', 'finished', 'skimmed', 'abandoned'];
export const isIDField = (field: string): boolean => ['author_id', 'series_id', 'tag_id'].includes(field);

export function shelfRuleGroups(shelf: Pick<Shelf, 'rule_groups' | 'rules'>, legacyName = 'Rules'): RuleGroup[] {
	const groups = shelf.rule_groups ?? (shelf.rules ? [{ id: 'legacy', name: legacyName, rules: shelf.rules }] : []);
	return groups.map((group) => ({ ...group, rules: { ...group.rules, conditions: group.rules.conditions.map((condition) => ({ ...condition })) } }));
}

export function validRuleGroups(groups: readonly RuleGroup[]): boolean {
	if (groups.length > 20) return false;
	const ids = new Set<string>();
	return groups.every((group) => {
		if (!/^[A-Za-z0-9_-]{1,100}$/.test(group.id) || ids.has(group.id) || !group.name.trim() ||
			new TextEncoder().encode(group.name.trim()).length > 1024 || /[\u0000-\u001f\u007f]/.test(group.name)) return false;
		ids.add(group.id);
		const { match, conditions } = group.rules;
		return (match === 'all' || match === 'any') && conditions.length > 0 && conditions.length <= 20 &&
			conditions.every(({ field, op, value }) => {
				if (!(RULE_FIELDS as readonly string[]).includes(field) || op !== (field === 'title' ? 'contains' : 'eq')) return false;
				if (isIDField(field)) return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
				if (typeof value !== 'string') return false;
				if (field === 'title') return value.trim().length > 0 && [...value].length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
				if (field === 'language') return value.length <= 35 && /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(value);
				if (field === 'format') return RULE_FORMATS.includes(value);
				return RULE_STATUSES.includes(value);
			});
	});
}

export function removedRuleGroups(before: readonly RuleGroup[], after: readonly RuleGroup[]): boolean {
	return before.some((group) => !after.some((candidate) => candidate.id === group.id));
}
