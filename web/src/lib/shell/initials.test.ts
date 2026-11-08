import { describe, expect, it } from 'vitest';
import { initials } from './initials.js';

describe('initials', () => {
	it('uses at most the first letter of two words', () => {
		expect(initials('  jane doe smith ')).toBe('JD');
		expect(initials('reader')).toBe('R');
		expect(initials('')).toBe('');
	});

	it('keeps Unicode letters intact', () => {
		expect(initials('李 小龙')).toBe('李小');
	});
});
