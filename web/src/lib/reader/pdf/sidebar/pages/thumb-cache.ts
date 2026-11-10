export class ThumbCache {
	private readonly entries = new Map<string, ImageBitmap>();

	constructor(private readonly limit = 300) {
		if (!Number.isSafeInteger(limit) || limit < 1) {
			throw new RangeError('Thumbnail cache limit must be a positive integer.');
		}
	}

	get size(): number {
		return this.entries.size;
	}

	get(page: number, rotation: number): ImageBitmap | undefined {
		const key = this.key(page, rotation);
		const bitmap = this.entries.get(key);
		if (!bitmap) return undefined;
		this.entries.delete(key);
		this.entries.set(key, bitmap);
		return bitmap;
	}

	set(page: number, rotation: number, bitmap: ImageBitmap): void {
		const key = this.key(page, rotation);
		const previous = this.entries.get(key);
		if (previous && previous !== bitmap) previous.close();
		this.entries.delete(key);
		this.entries.set(key, bitmap);
		while (this.entries.size > this.limit) {
			const oldest = this.entries.entries().next().value as [string, ImageBitmap] | undefined;
			if (!oldest) break;
			this.entries.delete(oldest[0]);
			oldest[1].close();
		}
	}

	clear(): void {
		for (const bitmap of this.entries.values()) bitmap.close();
		this.entries.clear();
	}

	private key(page: number, rotation: number): string {
		return `${page}:${rotation}`;
	}
}
