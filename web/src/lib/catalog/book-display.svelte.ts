export interface BookDisplayPreferences {
	size: number;
	spacing: number;
}

const STORAGE_KEY = 'pandalibrary.book-display';
const DEFAULT_PREFERENCES: BookDisplayPreferences = { size: 208, spacing: 20 };

/** Quick presets shared by the dashboard, library, and collection cover views. */
export const BOOK_DISPLAY_PRESETS = [
	{ id: 'small', size: 120, spacing: 8 },
	{ id: 'medium', size: 160, spacing: 12 },
	{ id: 'big', size: 208, spacing: 20 },
	{ id: 'large', size: 240, spacing: 24 }
] as const;

export type BookDisplayPresetId = (typeof BOOK_DISPLAY_PRESETS)[number]['id'];

export const bookDisplay = $state({ ...DEFAULT_PREFERENCES, error: false });

function parsePreferences(value: unknown): BookDisplayPreferences {
	if (typeof value !== 'object' || value === null ||
		!('size' in value) || typeof value.size !== 'number' ||
		!('spacing' in value) || typeof value.spacing !== 'number' ||
		!Number.isInteger(value.size) || value.size < 100 || value.size > 280 ||
		!Number.isInteger(value.spacing) || value.spacing < 0 || value.spacing > 48 ||
		value.spacing % 2 !== 0) {
		throw new Error('Invalid saved book display settings');
	}
	return { size: value.size, spacing: value.spacing };
}

function applyPreferences(preferences: BookDisplayPreferences) {
	bookDisplay.size = preferences.size;
	bookDisplay.spacing = preferences.spacing;
	bookDisplay.error = false;
}

export function initializeBookDisplay(): () => void {
	if (typeof window === 'undefined') return () => {};
	try {
		const stored = window.localStorage.getItem(STORAGE_KEY);
		if (stored !== null) applyPreferences(parsePreferences(JSON.parse(stored)));
	} catch (error) {
		console.error('Could not restore book display settings', error);
		bookDisplay.error = true;
	}

	const syncPreferences = (event: StorageEvent) => {
		if (event.key !== STORAGE_KEY) return;
		try {
			applyPreferences(event.newValue === null
				? DEFAULT_PREFERENCES
				: parsePreferences(JSON.parse(event.newValue)));
		} catch (error) {
			console.error('Could not restore book display settings', error);
			bookDisplay.error = true;
		}
	};
	window.addEventListener('storage', syncPreferences);
	return () => window.removeEventListener('storage', syncPreferences);
}

export function updateBookDisplay(update: Partial<BookDisplayPreferences>): void {
	const next = parsePreferences({
		size: update.size ?? bookDisplay.size,
		spacing: update.spacing ?? bookDisplay.spacing
	});
	applyPreferences(next);
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch (error) {
		console.error('Could not save book display settings', error);
		bookDisplay.error = true;
	}
}

export function applyBookDisplayPreset(id: BookDisplayPresetId): void {
	const preset = BOOK_DISPLAY_PRESETS.find((candidate) => candidate.id === id);
	if (preset) updateBookDisplay({ size: preset.size, spacing: preset.spacing });
}
