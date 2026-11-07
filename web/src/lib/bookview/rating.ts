export type StarFill = 'full' | 'half' | 'empty';

export function ratingStars(value: number | null): StarFill[] {
	if (value !== null && (!Number.isInteger(value) || value < 1 || value > 10)) {
		throw new RangeError('Rating must be between 1 and 10.');
	}
	return Array.from({ length: 5 }, (_, index) => {
		const remaining = (value ?? 0) - index * 2;
		return remaining >= 2 ? 'full' : remaining === 1 ? 'half' : 'empty';
	});
}

export function nextRating(value: number | null, key: string): number | null {
	if (value !== null) ratingStars(value);
	switch (key) {
		case 'ArrowRight':
		case 'ArrowUp': return Math.min(10, (value ?? 0) + 1);
		case 'ArrowLeft':
		case 'ArrowDown': return Math.max(1, (value ?? 2) - 1);
		case 'Home': return 1;
		case 'End': return 10;
		default: return null;
	}
}
