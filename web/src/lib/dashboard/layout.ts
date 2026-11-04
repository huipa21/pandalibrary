import type { JsonValue } from '#lib/api/client.js';
import type { Setting } from '#lib/reader/types.js';

export const DASHBOARD_SETTING = 'dashboard.layout.v1';
export const BUILT_IN_SECTIONS = [
	'continue_reading',
	'recently_added',
	'read',
	'unread',
	'want_to_read'
] as const;

export type BuiltInSection = (typeof BUILT_IN_SECTIONS)[number];
export type SectionId = BuiltInSection | `shelf:${number}`;

export const DEFAULT_SECTIONS: readonly SectionId[] = ['continue_reading', 'recently_added', 'read'];
const MAX_SETTING_BYTES = 64 * 1024;

export function isBuiltInSection(section: SectionId): section is BuiltInSection {
	return BUILT_IN_SECTIONS.some((builtIn) => builtIn === section);
}

export function shelfSection(id: number): SectionId {
	if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid shelf ID.');
	return `shelf:${id}`;
}

export function shelfId(section: SectionId): number | null {
	if (!section.startsWith('shelf:')) return null;
	return Number(section.slice('shelf:'.length));
}

export function parseSectionId(value: unknown): SectionId | null {
	if (typeof value !== 'string') return null;
	const builtIn = BUILT_IN_SECTIONS.find((section) => section === value);
	if (builtIn) return builtIn;
	if (!/^shelf:[1-9]\d*$/.test(value)) return null;
	const id = Number(value.slice('shelf:'.length));
	return Number.isSafeInteger(id) ? shelfSection(id) : null;
}

export type ParsedLayout =
	| { valid: true; sections: SectionId[]; missing: boolean }
	| { valid: false };

export function parseLayout(setting: Setting | undefined): ParsedLayout {
	if (setting === undefined) return { valid: true, sections: [...DEFAULT_SECTIONS], missing: true };
	const value: unknown = setting.value;
	if (typeof value !== 'object' || value === null || Array.isArray(value) ||
		!('version' in value) || value.version !== 1 ||
		!('sections' in value) || !Array.isArray(value.sections)) {
		return { valid: false };
	}
	const sections: SectionId[] = [];
	for (const section of value.sections) {
		if (typeof section !== 'object' || section === null || Array.isArray(section) || !('id' in section)) {
			return { valid: false };
		}
		const id = parseSectionId(section.id);
		if (!id || sections.includes(id)) return { valid: false };
		sections.push(id);
	}
	return { valid: true, sections, missing: false };
}

export class LayoutTooLargeError extends Error {
	constructor() {
		super('The dashboard layout exceeds the settings size limit.');
		this.name = 'LayoutTooLargeError';
	}
}

export function layoutValue(sections: readonly SectionId[]): JsonValue {
	if (new Set(sections).size !== sections.length || sections.some((id) => parseSectionId(id) !== id)) {
		throw new Error('Invalid dashboard sections.');
	}
	const value = { version: 1, sections: sections.map((id) => ({ id })) };
	if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_SETTING_BYTES) {
		throw new LayoutTooLargeError();
	}
	return value;
}

export function moveSection(sections: readonly SectionId[], id: SectionId, direction: -1 | 1): SectionId[] {
	const from = sections.indexOf(id);
	const to = from + direction;
	if (from < 0 || to < 0 || to >= sections.length) return [...sections];
	const result = [...sections];
	[result[from], result[to]] = [result[to], result[from]];
	return result;
}
