/**
 * Roving tabindex for `role="toolbar"`: one item (`[data-roving]`) is tabbable; arrows, Home and End move
 * focus. Nested widgets (the colour radio group) handle their own arrow keys and stop propagation.
 */
export function roving(node: HTMLElement) {
	const items = () => [...node.querySelectorAll<HTMLElement>('[data-roving]')].filter((item) => !(item as HTMLButtonElement).disabled);
	function settle(active?: HTMLElement) {
		const list = items();
		const current = active && list.includes(active) ? active : list.find((item) => item.tabIndex === 0) ?? list[0];
		for (const item of list) item.tabIndex = item === current ? 0 : -1;
	}
	function onkeydown(event: KeyboardEvent) {
		const list = items();
		const index = list.indexOf(document.activeElement as HTMLElement);
		if (index < 0) return;
		const vertical = node.getAttribute('aria-orientation') === 'vertical';
		const steps: Record<string, number> = vertical ? { ArrowDown: 1, ArrowUp: -1 } : { ArrowRight: 1, ArrowLeft: -1 };
		let next: number;
		if (event.key in steps) next = (index + steps[event.key] + list.length) % list.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = list.length - 1;
		else return;
		event.preventDefault();
		settle(list[next]);
		list[next].focus();
	}
	function onfocusin(event: FocusEvent) {
		if (event.target instanceof HTMLElement && event.target.hasAttribute('data-roving')) settle(event.target);
	}
	settle();
	const observer = new MutationObserver(() => settle());
	observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
	node.addEventListener('keydown', onkeydown);
	node.addEventListener('focusin', onfocusin);
	return {
		destroy() {
			observer.disconnect();
			node.removeEventListener('keydown', onkeydown);
			node.removeEventListener('focusin', onfocusin);
		}
	};
}
