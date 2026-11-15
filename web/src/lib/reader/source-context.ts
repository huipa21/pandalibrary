import type { JsonValue } from '#lib/api/client.js';
import { isLocatorForFormat, type ReaderFormat, type ReaderLocator } from './types.js';

export function sourceContext(
	rawLocator: string | null | undefined,
	rawFraction: string | null | undefined,
	format: ReaderFormat
): { locator: ReaderLocator | null; fraction: number | null } | null {
	if (rawLocator == null && rawFraction == null) return null;
	let locator: ReaderLocator | null = null;
	if (rawLocator && rawLocator.length <= 64_000) {
		try {
			const value: JsonValue = JSON.parse(rawLocator);
			if (isLocatorForFormat(value, format)) {
				locator = value.type === 'pdf'
					? { type: 'pdf', page: value.page, ...(value.rects ? { rects: value.rects } : {}) }
					: { type: 'cfi', value: value.value };
			}
		} catch { /* Malformed external context links never reach the engine. */ }
	}
	const fraction = rawFraction?.trim() ? Number(rawFraction) : NaN;
	return { locator, fraction: Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? fraction : null };
}
