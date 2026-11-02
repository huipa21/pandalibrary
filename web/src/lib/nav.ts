export interface NavigationItem {
	readonly id: string;
	readonly href: string;
	readonly label: string;
}

export const navigation: readonly NavigationItem[] = [];
