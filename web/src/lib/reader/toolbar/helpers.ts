export function parsePage(value: string, pageCount: number): number | null {
	if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(pageCount) || pageCount < 1) return null;
	const page = Number(value.trim());
	return Math.max(1, Math.min(pageCount, page));
}

export function formatProgress(fraction: number, locale: string): string {
	const value = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
	return `${new Intl.NumberFormat(locale, {
		minimumFractionDigits: 2, maximumFractionDigits: 2
	}).format(value * 100)}%`;
}
