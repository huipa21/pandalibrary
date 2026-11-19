import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOADING_TEXT_DELAY_MS, showLoadingAfterDelay } from './deferred.js';

describe('showLoadingAfterDelay', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('keeps loading copy hidden until the delay has elapsed', () => {
		vi.useFakeTimers();
		const node = { hidden: false } as HTMLElement;
		const action = showLoadingAfterDelay(node);

		expect(node.hidden).toBe(true);
		vi.advanceTimersByTime(LOADING_TEXT_DELAY_MS - 1);
		expect(node.hidden).toBe(true);
		vi.advanceTimersByTime(1);
		expect(node.hidden).toBe(false);

		action.destroy();
	});

	it('does not reveal the message when the element is removed early', () => {
		vi.useFakeTimers();
		const node = { hidden: false } as HTMLElement;
		const action = showLoadingAfterDelay(node);
		action.destroy();

		vi.advanceTimersByTime(LOADING_TEXT_DELAY_MS);

		expect(node.hidden).toBe(true);
	});
});
