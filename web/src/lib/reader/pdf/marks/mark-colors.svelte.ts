import { highlightColor, isMarkColor, type MarkColor } from '../../annotations.js';
import type { HighlightStyle } from '../../types.js';

const HIGHLIGHT_KEY = 'pandalibrary.mark-color.highlight';
const LINE_KEY = 'pandalibrary.mark-color.line';
const CUSTOM_KEY = 'pandalibrary.mark-color.custom';

type ColorStorage = Pick<Storage, 'getItem' | 'setItem'>;

export class MarkColors {
	private highlight = $state<MarkColor>('yellow');
	private line = $state<MarkColor>('#000000');
	custom = $state<string | null>(null);
	storageError = $state(false);

	constructor(private readonly storage: () => ColorStorage | undefined = () =>
		typeof window === 'undefined' ? undefined : window.localStorage) {
		try {
			const store = this.storage();
			if (!store) return;
			this.highlight = this.read(store, HIGHLIGHT_KEY, 'yellow');
			this.line = this.read(store, LINE_KEY, '#000000');
			const custom = store.getItem(CUSTOM_KEY);
			if (custom !== null) {
				if (isMarkColor(custom) && custom.startsWith('#')) this.custom = custom.toLowerCase();
				else console.warn(`Invalid stored mark colour for ${CUSTOM_KEY}`);
			}
		} catch (error) {
			this.reportStorageError(error);
		}
	}

	get(style: HighlightStyle): MarkColor {
		return style === 'highlight' ? this.highlight : this.line;
	}

	set(style: HighlightStyle, color: MarkColor): void {
		if (!isMarkColor(color)) throw new Error('Invalid mark color.');
		const normalized = highlightColor(color);
		const highlight = style === 'highlight';
		if (highlight) this.highlight = normalized;
		else this.line = normalized;
		this.write(highlight ? HIGHLIGHT_KEY : LINE_KEY, normalized);
	}

	setCustom(color: string): void {
		if (!isMarkColor(color) || !color.startsWith('#')) throw new Error('Invalid custom mark color.');
		this.custom = color.toLowerCase();
		this.write(CUSTOM_KEY, this.custom);
	}

	private read(store: ColorStorage, key: string, fallback: MarkColor): MarkColor {
		const value = store.getItem(key);
		if (value === null) return fallback;
		if (isMarkColor(value)) return highlightColor(value);
		console.warn(`Invalid stored mark colour for ${key}`);
		return fallback;
	}

	private write(key: string, value: string): void {
		try {
			this.storage()?.setItem(key, value);
			this.storageError = false;
		} catch (error) {
			this.reportStorageError(error);
		}
	}

	private reportStorageError(error: unknown): void {
		console.error('Could not access mark colour preferences', error);
		this.storageError = true;
	}
}

export const markColors = new MarkColors();
