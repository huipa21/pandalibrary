import en from '../../../messages/en.json';
import zh from '../../../messages/zh.json';
import { describe, expect, it } from 'vitest';

type Messages = Record<string, string>;

const bookViewKeys = (messages: Messages) => Object.keys(messages).filter((key) => /^(?:bv\d+|bc4)\./.test(key)).sort();
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('book view and cover tile messages', () => {
	it('has the same keys in English and Chinese', () => {
		expect(bookViewKeys(en)).not.toHaveLength(0);
		expect(bookViewKeys(zh)).toEqual(bookViewKeys(en));
	});

	it('has non-empty translations with matching placeholders', () => {
		for (const key of bookViewKeys(en)) {
			const english = (en as Messages)[key];
			const chinese = (zh as Messages)[key];
			expect(english.trim(), key).not.toBe('');
			expect(chinese.trim(), key).not.toBe('');
			expect(placeholders(chinese), key).toEqual(placeholders(english));
		}
	});
});
