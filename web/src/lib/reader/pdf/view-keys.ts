import { toolShortcut, type PdfTool } from '../views/pdf-view-state.js';

export type ViewKeyAction =
	| { type: 'turn'; direction: -1 | 1 }
	| { type: 'page'; end: boolean }
	| { type: 'zoom'; direction: -1 | 0 | 1 }
	| { type: 'tool'; tool: PdfTool }
	| { type: 'rotate'; delta: -90 | 90 }
	| { type: 'escape' };

export function viewKey(
	event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
	editable = false,
	menuOpen = false
): ViewKeyAction | null {
	if (editable || menuOpen || event.altKey) return null;
	if (event.ctrlKey || event.metaKey) {
		if (event.key === '+' || event.key === '=') return { type: 'zoom', direction: 1 };
		if (event.key === '-') return { type: 'zoom', direction: -1 };
		if (event.key === '0') return { type: 'zoom', direction: 0 };
		return null;
	}
	if (event.key === 'Escape') return { type: 'escape' };
	if (event.key === ' ') return { type: 'turn', direction: event.shiftKey ? -1 : 1 };
	if (!event.shiftKey) {
		if (event.key === 'ArrowLeft' || event.key === 'PageUp') return { type: 'turn', direction: -1 };
		if (event.key === 'ArrowRight' || event.key === 'PageDown') return { type: 'turn', direction: 1 };
		if (event.key === 'Home' || event.key === 'End') return { type: 'page', end: event.key === 'End' };
	}
	const tool = toolShortcut(event, null);
	if (tool) return { type: 'tool', tool };
	return event.key.toLowerCase() === 'r' ? { type: 'rotate', delta: event.shiftKey ? -90 : 90 } : null;
}

export function editableTarget(target: EventTarget | null): boolean {
	return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}
