import { afterEach, describe, expect, it, vi } from 'vitest';
import { cropRect, exportCoverCrop, MAX_COVER_BYTES, validateCoverFile } from './image-crop.js';

afterEach(() => vi.unstubAllGlobals());

describe('cover crop geometry', () => {
	it('selects a centered 2:3 region in landscape and portrait originals', () => {
		expect(cropRect(1200, 900)).toEqual({ x: 300, y: 0, width: 600, height: 900 });
		expect(cropRect(600, 1800)).toEqual({ x: 0, y: 450, width: 600, height: 900 });
	});

	it('keeps every pan and zoom combination inside the original at cover aspect', () => {
		for (const [width, height] of [[1200, 900], [600, 1800], [1, 1], [8000, 1]]) {
			for (const x of [-10, 0, 0.25, 1, 10]) {
				for (const y of [-10, 0, 0.75, 1, 10]) {
					for (const zoom of [-1, 1, 2, 5, 99]) {
						const crop = cropRect(width, height, x, y, zoom);
						expect(crop.x).toBeGreaterThanOrEqual(0);
						expect(crop.y).toBeGreaterThanOrEqual(0);
						expect(crop.x + crop.width).toBeLessThanOrEqual(width + 1e-8);
						expect(crop.y + crop.height).toBeLessThanOrEqual(height + 1e-8);
						expect(crop.width / crop.height).toBeCloseTo(2 / 3);
					}
				}
			}
		}
	});

	it('allows choosing the bottom-right region and smaller regions on zoom', () => {
		expect(cropRect(1200, 900, 1, 1, 2)).toEqual({ x: 900, y: 450, width: 300, height: 450 });
		expect(cropRect(1200, 900, 0, 0, 2)).toEqual({ x: 0, y: 0, width: 300, height: 450 });
	});

	it.each([[0, 5], [5, -1], [NaN, 5], [5, Infinity]])('rejects invalid source dimensions (%s, %s)', (width, height) => {
		expect(() => cropRect(width, height)).toThrow(RangeError);
	});
});

describe('cover uploads', () => {
	it('rejects SVG even when disguised as a permitted MIME type', async () => {
		await expect(validateCoverFile(new File(['<svg/>'], 'fake.png', { type: 'image/png' }))).rejects.toMatchObject({ code: 'type' });
		await expect(validateCoverFile(new File(['<svg/>'], 'cover.svg', { type: 'image/svg+xml' }))).rejects.toMatchObject({ code: 'type' });
	});

	it('accepts supported raster signatures and rejects oversized input before reading it', async () => {
		for (const [type, bytes] of [
			['image/jpeg', [255, 216, 255]],
			['image/png', [137, 80, 78, 71, 13, 10, 26, 10]],
			['image/webp', [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]]
		] as const) {
			await expect(validateCoverFile(new File([new Uint8Array(bytes)], 'cover', { type }))).resolves.toBeUndefined();
		}
		await expect(validateCoverFile({ size: 21 * 1024 * 1024 } as File)).rejects.toMatchObject({ code: 'size' });
	});
});

describe('cover JPEG export', () => {
	function setup(sizes: number[]) {
		const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
		const canvas = {
			width: 0, height: 0, getContext: () => context,
			toBlob: vi.fn((callback: BlobCallback, type: string) => callback(new Blob([new Uint8Array(sizes.shift() ?? MAX_COVER_BYTES)], { type })))
		};
		vi.stubGlobal('document', { createElement: () => canvas });
		vi.stubGlobal('FileReader', class {
			result = '';
			onload = () => {};
			readAsDataURL(blob: Blob) {
				this.result = `data:image/jpeg;base64,${'A'.repeat(Math.ceil(blob.size / 3) * 4)}`;
				this.onload();
			}
		});
		return { canvas, context };
	}

	it('reduces quality until strictly below the decoded limit and exports exactly 600 × 900', async () => {
		const { canvas, context } = setup([MAX_COVER_BYTES, 500_000]);
		const source = {} as HTMLImageElement;
		const crop = cropRect(1200, 900, 1, 1, 2);
		const result = await exportCoverCrop(source, crop);
		expect(canvas.width).toBe(600);
		expect(canvas.height).toBe(900);
		expect(context.drawImage).toHaveBeenCalledWith(source, 900, 450, 300, 450, 0, 0, 600, 900);
		expect(canvas.toBlob).toHaveBeenCalledTimes(2);
		expect(canvas.toBlob.mock.calls.map((call) => call[1])).toEqual(['image/jpeg', 'image/jpeg']);
		expect(result.length).toBeLessThan(820_000);
		expect(context.fillRect).toHaveBeenCalledWith(0, 0, 600, 900);
	});

	it('fails explicitly when no encoding meets the size budget', async () => {
		setup([]);
		await expect(exportCoverCrop({} as HTMLImageElement, cropRect(600, 900))).rejects.toMatchObject({ code: 'encode' });
	});
});
