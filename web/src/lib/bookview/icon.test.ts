import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Icon from './Icon.svelte';
import { homeNavigation } from '#lib/nav.js';
import { entityIcon, selectableIcons } from '#lib/navigation-icons.js';

describe('semantic navigation icons', () => {
	it('renders distinct decorative shapes for wordbooks, collections, libraries and involved books', () => {
		const names = [
			homeNavigation.find((item) => item.id === 'wordbooks')!.icon,
			entityIcon('', 'collection:1'),
			entityIcon('', 'library:1'),
			'books'
		] as const;
		const shapes = names.map((name) => {
			const { body } = render(Icon, { props: { name, class: 'size-4' } });
			expect(body).toContain('aria-hidden="true"');
			expect(body).toContain('viewBox="0 0 24 24"');
			const shape = body.match(/<(?:path|rect)\b[^>]+>/g)?.join('');
			expect(shape).toBeTruthy();
			return shape;
		});
		expect(new Set(shapes).size).toBe(names.length);
	});

	it('renders about 100 distinct selectable icons', () => {
		expect(selectableIcons.length).toBeGreaterThanOrEqual(95);
		expect(selectableIcons.length).toBeLessThanOrEqual(110);
		expect(new Set(selectableIcons).size).toBe(selectableIcons.length);
		const shapes = selectableIcons.map((name) => {
			const { body } = render(Icon, { props: { name } });
			expect(body).toContain('<svg');
			expect(body).toContain('aria-hidden="true"');
			const shape = body.match(/<(?:path|rect|circle|ellipse|line|polyline|polygon)\b[^>]+>/g)?.join('');
			expect(shape, name).toBeTruthy();
			return shape;
		});
		expect(new Set(shapes).size).toBe(selectableIcons.length);
	});
});
