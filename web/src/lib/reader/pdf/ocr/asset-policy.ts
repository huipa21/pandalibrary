export function isOcrAsset(path: string): boolean {
	return path.startsWith('/_app/immutable/ocr/');
}
