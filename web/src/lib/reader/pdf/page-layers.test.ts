import { describe, expect, it, vi } from 'vitest';
import { PageLayers } from './page-layers.js';
import type { PageLayerPainter } from './types.js';

function painter(name: string) {
	return { name, z: 1, paint: vi.fn(), dispose: vi.fn(() => {}) } satisfies PageLayerPainter;
}

describe('page painter lifecycle', () => {
	it('disposes replaced, unregistered and cleared painters exactly once', () => {
		const layers = new PageLayers(() => [], () => null);
		const first = painter('highlight');
		const second = painter('highlight');
		const insert = painter('inserts');
		const removeFirst = layers.register(first);
		const removeSecond = layers.register(second);
		expect(first.dispose).toHaveBeenCalledOnce();
		removeFirst();
		expect(first.dispose).toHaveBeenCalledOnce();
		const removeInsert = layers.register(insert);
		removeSecond();
		expect(second.dispose).toHaveBeenCalledOnce();
		layers.clear();
		expect(insert.dispose).toHaveBeenCalledOnce();
		removeInsert();
		expect(insert.dispose).toHaveBeenCalledOnce();
	});
});
