import type { IconName } from '#lib/bookview/Icon.svelte';

export const selectableIcons = [
	'book-open', 'bookmark', 'star', 'folder-plus', 'globe', 'image', 'pen', 'file',
	'list-tree', 'message', 'highlighter', 'lock'
] as const satisfies readonly IconName[];

export function entityIcon(icon: string | null | undefined, key: string): IconName {
	const selected = selectableIcons.find((candidate) => candidate === icon);
	if (selected) return selected;
	if (key.startsWith('library:')) return 'library';
	if (key.startsWith('collection:')) return 'folder';
	let hash = 2166136261;
	for (const character of key) {
		hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
	}
	return selectableIcons[(hash >>> 0) % selectableIcons.length];
}
