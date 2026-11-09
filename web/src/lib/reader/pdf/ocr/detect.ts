export function needsOcr({ textChars, hasImages }: { textChars: number; hasImages: boolean }): boolean {
	return textChars < 20 && hasImages;
}
