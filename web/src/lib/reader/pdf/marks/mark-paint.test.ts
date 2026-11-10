import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeMarkTone } from './mark-paint.js';

afterEach(() => vi.unstubAllGlobals());

describe('mark tone observer', () => {
	it('repaints repeatedly from the original colour and disconnects on disposal', () => {
		let tone = 'light';
		const properties = new Map<string, string>();
		const mark = {
			dataset: { style: 'underline', markColor: '#000000' },
			style: { setProperty: (key: string, value: string) => properties.set(key, value), opacity: '', mixBlendMode: '' }
		};
		const reader = {
			closest: () => reader,
			getAttribute: (name: string) => name === 'data-tone' ? tone : null,
			querySelectorAll: () => [mark]
		};
		const layer = { closest: () => reader };
		let callback: MutationCallback | undefined;
		const disconnect = vi.fn();
		class Observer {
			constructor(notify: MutationCallback) { callback = notify; }
			observe() {}
			disconnect = disconnect;
		}
		vi.stubGlobal('MutationObserver', Observer);
		vi.stubGlobal('document', { createElement: (tag: string) => tag === 'div' ? layer : { closest: () => null } });

		const observer = observeMarkTone();
		observer.watch(document.createElement('div'));
		expect(callback).toBeDefined();
		expect(observer.watch(document.createElement('span'))).toBe('light');
		expect(disconnect).not.toHaveBeenCalled();
		tone = 'dark';
		callback!([], null!);
		expect(properties.get('--pv-mark')).toBe('#e5e7eb');
		expect(mark.dataset.markColor).toBe('#000000');
		expect(observer.watch(document.createElement('span'))).toBe('dark');
		expect(disconnect).not.toHaveBeenCalled();
		tone = 'light';
		callback!([], null!);
		expect(properties.get('--pv-mark')).toBe('#000000');
		expect(mark.dataset.markColor).toBe('#000000');
		observer.dispose();
		expect(disconnect).toHaveBeenCalledOnce();
	});

	it('uses the reader viewport when the first painted page is detached', () => {
		const reader = {
			closest: () => reader,
			getAttribute: (name: string) => name === 'data-tone' ? 'dark' : null,
			querySelectorAll: () => []
		};
		const disconnected = { closest: () => null };
		const observe = vi.fn();
		class Observer {
			observe = observe;
			disconnect() {}
		}
		vi.stubGlobal('MutationObserver', Observer);
		vi.stubGlobal('document', { createElement: (tag: string) => tag === 'div' ? reader : disconnected });
		const observer = observeMarkTone(() => document.createElement('div'));
		expect(observer.watch(document.createElement('span'))).toBe('dark');
		expect(observe).toHaveBeenCalledOnce();
		observer.dispose();
	});
});
