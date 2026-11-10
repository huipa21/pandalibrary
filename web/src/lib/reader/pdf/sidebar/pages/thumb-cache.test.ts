import { describe, expect, it, vi } from 'vitest';
import { ThumbCache } from './thumb-cache.js';

function bitmap() {
	return { close: vi.fn() } as unknown as ImageBitmap;
}

describe('ThumbCache', () => {
	it('evicts the least recently used bitmap and closes it', () => {
		const cache = new ThumbCache(2);
		const first = bitmap();
		const second = bitmap();
		const third = bitmap();

		cache.set(1, 0, first);
		cache.set(2, 0, second);
		expect(cache.get(1, 0)).toBe(first);
		cache.set(3, 0, third);

		expect(first.close).not.toHaveBeenCalled();
		expect(second.close).toHaveBeenCalledOnce();
		expect(cache.get(2, 0)).toBeUndefined();
		expect(cache.size).toBe(2);
	});

	it('keys rotated pages independently and closes entries on clear', () => {
		const cache = new ThumbCache();
		const upright = bitmap();
		const rotated = bitmap();
		cache.set(4, 0, upright);
		cache.set(4, 90, rotated);

		expect(cache.get(4, 0)).toBe(upright);
		expect(cache.get(4, 90)).toBe(rotated);
		cache.clear();

		expect(upright.close).toHaveBeenCalledOnce();
		expect(rotated.close).toHaveBeenCalledOnce();
		expect(cache.size).toBe(0);
	});

	it('closes the previous bitmap when replacing a key', () => {
		const cache = new ThumbCache();
		const previous = bitmap();
		const next = bitmap();
		cache.set(1, 0, previous);
		cache.set(1, 0, next);

		expect(previous.close).toHaveBeenCalledOnce();
		expect(cache.get(1, 0)).toBe(next);
	});
});
