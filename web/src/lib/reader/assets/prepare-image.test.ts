import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnotationImageError } from './errors.js';
import { MAX_INPUT_BYTES, MAX_PREPARED_BYTES, prepareAnnotationImage } from './prepare-image.js';

const encode = vi.fn<(options: ImageEncodeOptions) => Promise<Blob>>();
const close = vi.fn();
const drawImage = vi.fn();
const fillRect = vi.fn();
const pixels = vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }));
const bitmap = { width: 4096, height: 2048, close };
const decode = vi.fn().mockResolvedValue(bitmap);
const canvas = vi.fn();
const file = new Blob(['source'], { type: 'image/png' });
const encoded = (type: string, size = 10) => new Blob([new Uint8Array(size)], { type });

beforeEach(() => {
	vi.clearAllMocks();
	bitmap.width = 4096;
	bitmap.height = 2048;
	pixels.mockReturnValue({ data: new Uint8ClampedArray([0, 0, 0, 255]) });
	decode.mockResolvedValue(bitmap);
	encode.mockReset().mockResolvedValue(encoded('image/webp'));
	vi.stubGlobal('createImageBitmap', decode);
	vi.stubGlobal('OffscreenCanvas', class {
		constructor(width: number, height: number) { canvas(width, height); }
		getContext() { return { drawImage, getImageData: pixels, fillRect }; }
		convertToBlob = encode;
	});
});
afterEach(() => vi.unstubAllGlobals());

describe('annotation image preparation', () => {
	it('applies image orientation, downsizes to 2048 and encodes WebP at 0.85', async () => {
		const prepared = await prepareAnnotationImage(file);
		expect(decode).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
		expect(canvas).toHaveBeenCalledWith(2048, 1024);
		expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 2048, 1024);
		expect(encode).toHaveBeenCalledWith({ type: 'image/webp', quality: 0.85 });
		expect(prepared).toMatchObject({ width: 2048, height: 1024, media_type: 'image/webp' });
		expect(prepared.blob.size).toBeLessThanOrEqual(MAX_PREPARED_BYTES);
		expect(close).toHaveBeenCalledOnce();
	});

	it('does not upscale small images and handles tall, thin images', async () => {
		bitmap.width = 1;
		bitmap.height = 8000;
		expect(await prepareAnnotationImage(file)).toMatchObject({ width: 1, height: 2048 });
		bitmap.width = 100;
		bitmap.height = 50;
		expect(await prepareAnnotationImage(file)).toMatchObject({ width: 100, height: 50 });
	});

	it('retries JPEG at 0.85 then 0.7 when WebP is unsupported or too large', async () => {
		encode.mockResolvedValueOnce(encoded('image/png'))
			.mockResolvedValueOnce(encoded('image/jpeg', MAX_PREPARED_BYTES + 1))
			.mockResolvedValueOnce(encoded('image/jpeg'));
		expect(await prepareAnnotationImage(file)).toMatchObject({ media_type: 'image/jpeg' });
		expect(encode.mock.calls.map(([options]) => options)).toEqual([
			{ type: 'image/webp', quality: 0.85 }, { type: 'image/jpeg', quality: 0.85 }, { type: 'image/jpeg', quality: 0.7 }
		]);
		encode.mockReset().mockResolvedValueOnce(encoded('image/webp', MAX_PREPARED_BYTES + 1))
			.mockResolvedValueOnce(encoded('image/jpeg', MAX_PREPARED_BYTES));
		expect((await prepareAnnotationImage(file)).blob.size).toBe(MAX_PREPARED_BYTES);
	});

	it('keeps PNG only when transparent and within the budget', async () => {
		pixels.mockReturnValue({ data: new Uint8ClampedArray([0, 0, 0, 120]) });
		encode.mockResolvedValueOnce(encoded('image/png', MAX_PREPARED_BYTES));
		expect(await prepareAnnotationImage(file)).toMatchObject({ media_type: 'image/png' });
		expect(encode).toHaveBeenCalledOnce();
		encode.mockReset().mockResolvedValueOnce(encoded('image/webp', MAX_PREPARED_BYTES + 1))
			.mockResolvedValueOnce(encoded('image/png', MAX_PREPARED_BYTES + 1))
			.mockResolvedValueOnce(encoded('image/jpeg'));
		expect(await prepareAnnotationImage(file)).toMatchObject({ media_type: 'image/jpeg' });
		expect(fillRect).toHaveBeenCalled();
	});

	it('rejects non-images and oversized input before decoding', async () => {
		await expect(prepareAnnotationImage(new Blob(['x'], { type: 'text/plain' })))
			.rejects.toMatchObject({ code: 'unsupported_media_type' });
		await expect(prepareAnnotationImage(encoded('image/png', MAX_INPUT_BYTES + 1)))
			.rejects.toMatchObject({ code: 'input_too_large' });
		expect(decode).not.toHaveBeenCalled();
	});

	it('exposes typed decode/encode and size failures and always closes bitmaps', async () => {
		decode.mockRejectedValueOnce(new Error('decode'));
		await expect(prepareAnnotationImage(file)).rejects.toBeInstanceOf(AnnotationImageError);
		encode.mockRejectedValueOnce(new Error('canvas'));
		await expect(prepareAnnotationImage(file)).rejects.toMatchObject({ code: 'invalid_image' });
		encode.mockReset().mockResolvedValue(encoded('image/jpeg', MAX_PREPARED_BYTES + 1));
		await expect(prepareAnnotationImage(file)).rejects.toMatchObject({ code: 'asset_too_large' });
		expect(close).toHaveBeenCalledTimes(2);
		bitmap.width = 0;
		await expect(prepareAnnotationImage(file)).rejects.toMatchObject({ code: 'invalid_image_dimensions' });
	});
});
