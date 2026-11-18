import { READER_CONTENT_POINTER_EVENT } from '../content-pointer.js';

/** Space around an open menu that still counts as an intentional tap on it. */
export const MENU_DISMISS_MARGIN = 8;

export interface MenuRegistration {
	depth: number;
	root: HTMLElement;
	panel: HTMLElement;
	close: () => void;
}

const openMenus = new Set<MenuRegistration>();
let listening = false;
let focusGuardUntil = 0;

function guardPointerFocus(): void {
	focusGuardUntil = performance.now() + 300;
}

/** Keyboard focus changes still dismiss menus; pointer-driven ones use the menu stack instead. */
export function focusDismissAllowed(): boolean {
	return performance.now() >= focusGuardUntil;
}

function contains(menu: MenuRegistration, target: Node | null): boolean {
	return Boolean(target && (menu.root.contains(target) || menu.panel.contains(target)));
}

function withinMargin(element: HTMLElement, x: number, y: number): boolean {
	const rect = element.getBoundingClientRect();
	return x >= rect.left - MENU_DISMISS_MARGIN && x <= rect.right + MENU_DISMISS_MARGIN &&
		y >= rect.top - MENU_DISMISS_MARGIN && y <= rect.bottom + MENU_DISMISS_MARGIN;
}

function deepestMenu(): MenuRegistration | null {
	let deepest: MenuRegistration | null = null;
	for (const menu of openMenus) {
		if (!deepest || menu.depth > deepest.depth) deepest = menu;
	}
	return deepest;
}

function dismissDeepest(): void {
	deepestMenu()?.close();
}

function onPointerDown(event: PointerEvent): void {
	if (event.button !== 0 || !openMenus.size) return;
	guardPointerFocus();
	const target = event.target instanceof Node ? event.target : null;
	const deepest = deepestMenu();
	if (!deepest) return;
	// Taps inside the deepest menu (or just around it) never dismiss anything.
	if (contains(deepest, target) ||
		withinMargin(deepest.root, event.clientX, event.clientY) ||
		withinMargin(deepest.panel, event.clientX, event.clientY)) return;
	// A tap inside an ancestor menu is still outside the deepest level.
	for (const menu of openMenus) {
		if (contains(menu, target)) {
			dismissDeepest();
			return;
		}
	}
	// Reserve a small touch margin around the whole open menu space.
	for (const menu of openMenus) {
		if (withinMargin(menu.root, event.clientX, event.clientY) ||
			withinMargin(menu.panel, event.clientX, event.clientY)) return;
	}
	dismissDeepest();
}

function refreshPointerGuard(): void {
	if (openMenus.size) guardPointerFocus();
}

function onContentPointerDown(): void {
	guardPointerFocus();
	dismissDeepest();
}

function start(): void {
	if (listening) return;
	listening = true;
	// Capture so reader controls cannot stop an outside tap from dismissing menus.
	document.addEventListener('pointerdown', onPointerDown, true);
	document.addEventListener('pointerup', refreshPointerGuard, true);
	document.addEventListener('pointercancel', refreshPointerGuard, true);
	window.addEventListener(READER_CONTENT_POINTER_EVENT, onContentPointerDown);
}

function stop(): void {
	if (!listening) return;
	listening = false;
	document.removeEventListener('pointerdown', onPointerDown, true);
	document.removeEventListener('pointerup', refreshPointerGuard, true);
	document.removeEventListener('pointercancel', refreshPointerGuard, true);
	window.removeEventListener(READER_CONTENT_POINTER_EVENT, onContentPointerDown);
}

/** Registers an open menu until its returned cleanup runs. */
export function registerMenu(menu: MenuRegistration): () => void {
	openMenus.add(menu);
	start();
	return () => {
		openMenus.delete(menu);
		if (!openMenus.size) stop();
	};
}
