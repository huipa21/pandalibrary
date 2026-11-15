import { describe, expect, it } from 'vitest';
import { sourceContext } from './source-context.js';

describe('wordbook source context links', () => {
	it('accepts exact format-appropriate CFI and PDF positions', () => {
		const cfi = { type: 'cfi', value: 'epubcfi(/6/2!/4/2,1,8)' };
		expect(sourceContext(JSON.stringify(cfi), '0.321', 'epub')).toEqual({ locator: cfi, fraction: 0.321 });
		const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };
		expect(sourceContext(JSON.stringify({ type: 'pdf', page: 4, rects: [rect], parts: [{ page: 4 }] }), '0.75', 'pdf'))
			.toEqual({ locator: { type: 'pdf', page: 4, rects: [rect] }, fraction: 0.75 });
	});

	it.each([
		'not JSON', '{"type":"pdf","page":0}', '{"type":"pdf","page":1.2}',
		'{"type":"cfi","value":"javascript:alert(1)"}',
		'{"type":"pdf","page":2,"rects":[{"x":-1,"y":0,"width":1,"height":1}]}',
		'x'.repeat(64_001)
	])('rejects unsafe or malformed locators and retains the fraction fallback', (locator) => {
		expect(sourceContext(locator, '0.5', 'pdf')).toEqual({ locator: null, fraction: 0.5 });
	});

	it('rejects mismatched formats and invalid fractions without changing normal restoration', () => {
		expect(sourceContext(null, null, 'pdf')).toBeNull();
		for (const value of ['', ' ', '-1', '2', 'Infinity', 'no']) {
			expect(sourceContext('{"type":"cfi","value":"epubcfi(/6/2)"}', value, 'pdf')).toEqual({ locator: null, fraction: null });
		}
	});
});
