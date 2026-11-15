export const COVER_WIDTH = 600;
export const COVER_HEIGHT = 900;
export const MAX_COVER_BYTES = 600 * 1024;
export const MAX_COVER_DATA_URL_LENGTH = 820_000;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface CropRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Pan coordinates range from 0 (top/left) to 1 (bottom/right). */
export function cropRect(width: number, height: number, panX = 0.5, panY = 0.5, zoom = 1): CropRect {
	if (![width, height, panX, panY, zoom].every(Number.isFinite) || width <= 0 || height <= 0) {
		throw new RangeError('Invalid crop dimensions');
	}
	const cropWidth = Math.min(width, height * COVER_WIDTH / COVER_HEIGHT) / clamp(zoom, 1, 5);
	const cropHeight = cropWidth * COVER_HEIGHT / COVER_WIDTH;
	return {
		x: (width - cropWidth) * clamp(panX, 0, 1),
		y: (height - cropHeight) * clamp(panY, 0, 1),
		width: cropWidth,
		height: cropHeight
	};
}

export type CoverImageErrorCode = 'type' | 'size' | 'decode' | 'encode';

export class CoverImageError extends Error {
	constructor(readonly code: CoverImageErrorCode) {
		super(code);
	}
}

/** Check signatures as well as MIME: SVG uploads must never become image sources. */
export async function validateCoverFile(file: File): Promise<void> {
	if (file.size > MAX_UPLOAD_BYTES) throw new CoverImageError('size');
	const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
	const jpeg = file.type === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	const png = file.type === 'image/png' && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
	const webp = file.type === 'image/webp' &&
		String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
		String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
	if (!jpeg && !png && !webp) throw new CoverImageError('type');
}

function jpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

function dataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(new CoverImageError('encode'));
		reader.readAsDataURL(blob);
	});
}

export async function exportCoverCrop(source: HTMLImageElement, crop: CropRect): Promise<string> {
	try {
		const canvas = document.createElement('canvas');
		canvas.width = COVER_WIDTH;
		canvas.height = COVER_HEIGHT;
		const context = canvas.getContext('2d');
		if (!context) throw new CoverImageError('encode');
		context.fillStyle = '#ffffff';
		context.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
		context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, COVER_WIDTH, COVER_HEIGHT);
		for (const quality of [0.9, 0.8, 0.65, 0.5, 0.35, 0.2, 0.1, 0.05]) {
			const blob = await jpegBlob(canvas, quality);
			if (blob?.type !== 'image/jpeg' || blob.size === 0) throw new CoverImageError('encode');
			if (blob.size >= MAX_COVER_BYTES) continue;
			const result = await dataUrl(blob);
			if (result.length < MAX_COVER_DATA_URL_LENGTH) return result;
		}
		throw new CoverImageError('encode');
	} catch {
		throw new CoverImageError('encode');
	}
}
