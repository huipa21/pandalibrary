export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'pandalibrary.theme';
const THEME_COLORS: Record<Theme, string> = {
	light: '#ffffff',
	dark: '#191c1f'
};

export function initialTheme(stored: string | null, prefersDark: boolean): Theme {
	if (stored === 'light' || stored === 'dark') return stored;
	return prefersDark ? 'dark' : 'light';
}

export function readTheme(): Theme {
	let stored: string | null = null;
	if (typeof window !== 'undefined') {
		try {
			stored = window.localStorage.getItem(STORAGE_KEY);
		} catch (error) {
			console.error('Could not read the saved theme', error);
		}
	}
	const prefersDark = typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
	return initialTheme(stored, prefersDark);
}

export function applyTheme(theme: Theme): void {
	if (typeof document === 'undefined') return;
	document.documentElement.dataset.theme = theme;
	document.documentElement.style.colorScheme = theme;
	const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if (meta) meta.content = THEME_COLORS[theme];
}

export function saveTheme(theme: Theme): void {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(STORAGE_KEY, theme);
	} catch (error) {
		console.error('Could not save the selected theme', error);
	}
}
