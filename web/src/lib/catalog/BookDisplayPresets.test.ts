import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import BookDisplayPresets from './BookDisplayPresets.svelte';

describe('BookDisplayPresets', () => {
	it('renders one cover-size button without the old visible label or preset group', () => {
		const { body } = render(BookDisplayPresets);

		expect(body.match(/<button\b/g)).toHaveLength(1);
		expect(body).toContain('aria-label="Cover size"');
		expect(body).toContain('data-book-display-presets');
		expect(body).not.toContain('role="group"');
	});
});
