/** Plan decision 6: fractional progress with a saturated last page. */
export function toFraction(page: number, offset: number, pages: number): number {
	const off = Number.isFinite(offset) ? Math.min(1, Math.max(0, offset)) : 0;
	if (pages <= 1) return Math.min(1, off);
	return Math.min(1, Math.max(0, (page - 1 + off) / (pages - 1)));
}

export function fromFraction(fraction: number, pages: number): { page: number; offset: number } {
	const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
	if (pages <= 1) return { page: 1, offset: f };
	const x = f * (pages - 1);
	// Guards `(page - 1) / (pages - 1) * (pages - 1)` landing just below an integer.
	const page = Math.min(pages, 1 + Math.floor(x + 1e-9));
	return { page, offset: page === pages ? 0 : Math.max(0, x - (page - 1)) };
}

export function formatPercent(fraction: number, locale: string): string {
	const value = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
	return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value * 100)}%`;
}
