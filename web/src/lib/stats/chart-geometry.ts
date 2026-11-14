export interface ChartRect {
	index: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PieSlice {
	index: number;
	path: string;
}

export function chartWeights(values: readonly number[]): number[] {
	const safe = values.map((value) => Number.isFinite(value) && value > 0 ? value : 0);
	const max = safe.reduce((largest, value) => Math.max(largest, value), 0);
	return max ? safe.map((value) => value / max) : safe;
}

/** Balanced binary partition: every rectangle retains its exact share of the area. */
export function treemapRects(values: readonly number[], width = 100, height = 100): ChartRect[] {
	if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) return [];
	const items = chartWeights(values)
		.map((weight, index) => ({ weight, index }))
		.filter((item) => item.weight > 0)
		.sort((a, b) => b.weight - a.weight);
	const result: ChartRect[] = [];

	function split(group: typeof items, x: number, y: number, w: number, h: number) {
		if (!group.length) return;
		if (group.length === 1) {
			result.push({ index: group[0].index, x, y, width: w, height: h });
			return;
		}
		const total = group.reduce((sum, item) => sum + item.weight, 0);
		let first = group[0].weight;
		let cut = 1;
		while (cut < group.length - 1 && Math.abs(total / 2 - first - group[cut].weight) < Math.abs(total / 2 - first)) {
			first += group[cut++].weight;
		}
		const fraction = first / total;
		if (w >= h) {
			split(group.slice(0, cut), x, y, w * fraction, h);
			split(group.slice(cut), x + w * fraction, y, w * (1 - fraction), h);
		} else {
			split(group.slice(0, cut), x, y, w, h * fraction);
			split(group.slice(cut), x, y + h * fraction, w, h * (1 - fraction));
		}
	}

	split(items, 0, 0, width, height);
	return result;
}

export function pieSlices(values: readonly number[]): PieSlice[] {
	const weights = chartWeights(values);
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	if (!total) return [];
	let angle = -Math.PI / 2;
	return weights.flatMap((weight, index) => {
		if (!weight) return [];
		if (weight === total) {
			return [{ index, path: 'M 100 10 A 90 90 0 1 1 100 190 A 90 90 0 1 1 100 10 Z' }];
		}
		const start = angle;
		angle += (weight / total) * Math.PI * 2;
		const x1 = 100 + 90 * Math.cos(start);
		const y1 = 100 + 90 * Math.sin(start);
		const x2 = 100 + 90 * Math.cos(angle);
		const y2 = 100 + 90 * Math.sin(angle);
		return [{ index, path: `M 100 100 L ${x1} ${y1} A 90 90 0 ${angle - start > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z` }];
	});
}

/** Numeric keys (publication years) retain chronological gaps; other categories are evenly spaced. */
export function chartPositions(keys: readonly string[]): number[] {
	const numbers = keys.map((key) => key.trim() ? Number(key) : NaN);
	const first = numbers[0];
	const last = numbers[numbers.length - 1];
	const chronological = numbers.length > 1 && numbers.every((value, index) =>
		Number.isFinite(value) && (index === 0 || value > numbers[index - 1]));
	return keys.map((_, index) => chronological
		? (0.5 + (numbers.length - 1) * (numbers[index] - first) / (last - first)) / numbers.length
		: (index + 0.5) / keys.length);
}

export function areaPath(values: readonly number[], width = 640, height = 200, positions?: readonly number[]): string {
	const weights = chartWeights(values);
	if (!weights.length || !weights.some((value) => value > 0)) return '';
	const xs = weights.map((_, index) => (positions?.[index] ?? (index + 0.5) / weights.length) * width);
	const points = weights.map((weight, index) => `${xs[index]} ${height * (1 - weight)}`);
	if (points.length === 1) return `M 0 ${height} L 0 ${height * (1 - weights[0])} L ${width} ${height * (1 - weights[0])} L ${width} ${height} Z`;
	return `M ${xs[0]} ${height} L ${points.join(' L ')} L ${xs[xs.length - 1]} ${height} Z`;
}
