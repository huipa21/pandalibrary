const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keyboard-focusable descendants of a container, in document order. */
export function focusableWithin(container: HTMLElement | null): HTMLElement[] {
	if (!container) return [];
	return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
		(element) => !element.hasAttribute('inert') && element.getClientRects().length > 0
	);
}

/**
 * Returns the element that should receive focus so Tab cycles through `cycle` only. The cycle is not
 * contiguous in the document (the toggle lives in the header), so movement is always explicit.
 */
export function nextTrappedFocus<T>(cycle: readonly T[], active: unknown, backwards: boolean): T | null {
	if (cycle.length === 0) return null;
	const index = cycle.indexOf(active as T);
	if (index === -1) return backwards ? cycle[cycle.length - 1] : cycle[0];
	return cycle[(index + (backwards ? cycle.length - 1 : 1)) % cycle.length];
}
