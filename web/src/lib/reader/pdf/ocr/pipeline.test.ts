import { describe, expect, it } from 'vitest';
import { needsOcr } from './detect.js';
import { languageKey, ocrLanguagesFor } from './languages.js';
import { ocrScale } from './render-page.js';
import { joinOcrWords } from './text-layer.js';
import { isOcrAsset } from './asset-policy.js';
import { ocrResult } from './worker.js';

describe('scanned page detection', () => {
	it.each([
		[0, true, true], [19, true, true], [20, true, false],
		[100, true, false], [0, false, false], [19, false, false]
	])('%i characters with images=%s → %s', (textChars, hasImages, expected) => {
		expect(needsOcr({ textChars, hasImages })).toBe(expected);
	});
});

it.each(['en', 'eng', 'en-US', 'EN_gb'])('uses English for %s', (language) => {
	expect(ocrLanguagesFor(language)).toEqual(['eng']);
});

it.each(['zh', 'zh-CN', 'zh-Hans-SG', 'zh-SG', 'zh-TW', 'zh-Hant-HK', 'zh-HK', 'fr', '', null, undefined])(
	'uses both shipped languages for %s', (language) => {
		expect(ocrLanguagesFor(language)).toEqual(['chi_sim', 'eng']);
	}
);

it('canonicalizes language sets for cache and worker reuse', () => {
	expect(languageKey(['eng', 'chi_sim', 'eng'])).toBe('chi_sim+eng');
	expect(() => languageKey([])).toThrow('At least one');
});

it('limits rendering to 300 DPI and 3000 pixels', () => {
	expect(ocrScale(612, 792) * 792).toBe(3000);
	expect(ocrScale(100, 200)).toBe(300 / 72);
	expect(ocrScale(5000, 1000) * 5000).toBe(3000);
});

it('joins CJK characters without spaces, preserves Latin word boundaries', () => {
	const words = ['Scanned', 'PDF', '扫', '描', '样', '本'].map((text) => ({ text }));
	expect(joinOcrWords(words)).toBe('Scanned PDF 扫描样本');
});

it('excludes only same-origin immutable OCR assets from shell precaching', () => {
	expect(isOcrAsset('/_app/immutable/ocr/123/worker.min.js')).toBe(true);
	expect(isOcrAsset('/_app/immutable/chunks/worker.js')).toBe(false);
	expect(isOcrAsset('/api/ocr/')).toBe(false);
});

it('rejects missing OCR layout rather than caching empty success', () => {
	expect(() => ocrResult({ blocks: null }, 100, 100)).toThrow('no layout data');
	expect(ocrResult({ blocks: [] }, 100, 100)).toMatchObject({ lines: [], width: 100, height: 100 });
});
