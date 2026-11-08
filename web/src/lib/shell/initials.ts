export function initials(displayName: string): string {
	return displayName
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((word) => Array.from(word)[0] ?? '')
		.join('')
		.toLocaleUpperCase();
}
