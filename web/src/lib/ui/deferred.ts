/** How long a loading message stays out of sight before it is shown. */
export const LOADING_TEXT_DELAY_MS = 500;

/**
 * Defers a loading message so fast requests do not flash "Loading…" copy.
 *
 * Apply it to an element that is mounted only while loading is in progress.
 * Quick loads remove the element before the delay elapses; slow loads reveal
 * the message after {@link LOADING_TEXT_DELAY_MS}.
 */
export function showLoadingAfterDelay(node: HTMLElement, delay = LOADING_TEXT_DELAY_MS) {
	let timer: ReturnType<typeof setTimeout> | undefined;

	function schedule(nextDelay: number) {
		if (timer !== undefined) clearTimeout(timer);
		node.hidden = true;
		timer = setTimeout(() => {
			timer = undefined;
			node.hidden = false;
		}, nextDelay);
	}

	schedule(delay);

	return {
		update(nextDelay = LOADING_TEXT_DELAY_MS) {
			schedule(nextDelay);
		},
		destroy() {
			if (timer !== undefined) clearTimeout(timer);
		}
	};
}
