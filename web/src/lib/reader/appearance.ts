import type { ReaderSettings } from './types.js';

export type BackgroundId =
	| 'white' | 'cream' | 'sepia' | 'green' | 'wood'
	| 'gray' | 'blue' | 'pink' | 'night' | 'black';

export interface BackgroundPreset {
	id: BackgroundId;
	page: string;
	text: string;
	tone: 'light' | 'dark';
	grain?: string;
}

export const BACKGROUNDS: readonly BackgroundPreset[] = [
	{ id: 'white', page: '#ffffff', text: '#1f2937', tone: 'light' },
	{ id: 'cream', page: '#faf6ec', text: '#2b2b2b', tone: 'light' },
	{ id: 'sepia', page: '#f4ecd8', text: '#5b4636', tone: 'light' },
	{ id: 'green', page: '#c7edcc', text: '#1f3a24', tone: 'light' },
	{
		id: 'wood', page: '#dcc29b', text: '#3e2c1c', tone: 'light',
		grain: 'repeating-linear-gradient(90deg, rgb(0 0 0 / 3%) 0 2px, transparent 2px 7px)'
	},
	{ id: 'gray', page: '#e6e6e6', text: '#262626', tone: 'light' },
	{ id: 'blue', page: '#dce8f5', text: '#1e2a3a', tone: 'light' },
	{ id: 'pink', page: '#f9e3e3', text: '#3f2a2a', tone: 'light' },
	{ id: 'night', page: '#1c1c1e', text: '#c8c8c8', tone: 'dark' },
	{ id: 'black', page: '#000000', text: '#a3a3a3', tone: 'dark' }
];

const THEME_BACKGROUNDS: Record<ReaderSettings['theme'], BackgroundId> = {
	light: 'white',
	sepia: 'sepia',
	dark: 'night'
};

export function isBackgroundId(value: unknown): value is BackgroundId {
	return typeof value === 'string' && BACKGROUNDS.some((preset) => preset.id === value);
}

export function backgroundFor(settings: ReaderSettings): BackgroundPreset {
	const id = settings.background ?? THEME_BACKGROUNDS[settings.theme];
	const preset = BACKGROUNDS.find((candidate) => candidate.id === id);
	if (!preset) throw new Error(`Unknown reader background: ${String(id)}`);
	return preset;
}

export function themeFor(id: BackgroundId): ReaderSettings['theme'] {
	switch (id) {
		case 'night':
		case 'black':
			return 'dark';
		case 'cream':
		case 'sepia':
		case 'wood':
			return 'sepia';
		case 'white':
		case 'green':
		case 'gray':
		case 'blue':
		case 'pink':
			return 'light';
		default:
			throw new Error(`Unknown reader background: ${String(id)}`);
	}
}

export function withBackground(settings: ReaderSettings, id: BackgroundId): ReaderSettings {
	return { ...settings, background: id, theme: themeFor(id) };
}
