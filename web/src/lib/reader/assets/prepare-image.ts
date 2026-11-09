import { AnnotationImageError } from './errors.js';

export const MAX_PREPARED_BYTES = 2 << 20;
export const MAX_INPUT_BYTES = 20 << 20;
const MAX_EDGE = 2048;

export interface PreparedAnnotationImage {
	readonly blob: Blob;
	readonly width: number;
	readonly height: number;
	readonly media_type: 'image/png' | 'image/jpeg' | 'image/webp';
}

export async function prepareAnnotationImage(file: Blob): Promise<PreparedAnnotationImage> {
	if (!file.type.startsWith('image/')) throw new AnnotationImageError('unsupported_media_type');
	if (file.size > MAX_INPUT_BYTES) throw new AnnotationImageError('input_too_large');
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	} catch (cause) {
		throw new AnnotationImageError('invalid_image', { cause });
	}
	try {
		if (bitmap.width < 1 || bitmap.height < 1) throw new AnnotationImageError('invalid_image_dimensions');
		const ratio = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
		const width = Math.max(1, Math.round(bitmap.width * ratio));
		const height = Math.max(1, Math.round(bitmap.height * ratio));
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d', { willReadFrequently: true });
		if (!context) throw new AnnotationImageError('invalid_image');
		context.drawImage(bitmap, 0, 0, width, height);
		const webp = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
		if (webp.type === 'image/webp' && webp.size > 0 && webp.size <= MAX_PREPARED_BYTES) {
			return { blob: webp, width, height, media_type: 'image/webp' };
		}
		// Browsers without WebP encoding commonly return PNG; retain it only for alpha.
		const pixels = context.getImageData(0, 0, width, height).data;
		let transparent = false;
		for (let i = 3; i < pixels.length; i += 4) {
			if (pixels[i] < 255) {
				transparent = true;
				break;
			}
		}
		if (transparent) {
			const png = webp.type === 'image/png' ? webp : await canvas.convertToBlob({ type: 'image/png' });
			if (png.type === 'image/png' && png.size > 0 && png.size <= MAX_PREPARED_BYTES) {
				return { blob: png, width, height, media_type: 'image/png' };
			}
			context.globalCompositeOperation = 'destination-over';
			context.fillStyle = '#ffffff';
			context.fillRect(0, 0, width, height);
		}
		for (const quality of [0.85, 0.7]) {
			const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality });
			if (jpeg.type === 'image/jpeg' && jpeg.size > 0 && jpeg.size <= MAX_PREPARED_BYTES) {
				return { blob: jpeg, width, height, media_type: 'image/jpeg' };
			}
		}
		throw new AnnotationImageError('asset_too_large');
	} catch (cause) {
		if (cause instanceof AnnotationImageError) throw cause;
		throw new AnnotationImageError('invalid_image', { cause });
	} finally {
		bitmap.close();
	}
}
