import * as m from '#lib/paraglide/messages.js';
import { UNKNOWN_FORMAT } from './highlights-model.js';

const COLOR_NAMES: Record<string, () => string> = {
	yellow: m['bv9.color_yellow'],
	blue: m['bv9.color_blue'],
	red: m['bv9.color_red'],
	orange: m['bv9.color_orange'],
	green: m['bv9.color_green'],
	purple: m['bv9.color_purple'],
	pink: m['bv9.color_pink']
};

export function colorName(color: string): string {
	const key = color.toLowerCase();
	return Object.hasOwn(COLOR_NAMES, key) ? COLOR_NAMES[key]() : color;
}

export function formatLabel(format: string): string {
	return format === UNKNOWN_FORMAT ? m['bv9.format_unknown']() : format.toUpperCase();
}
