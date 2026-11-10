import { describe, expect, it } from 'vitest';
import { BACKGROUNDS, withBackground } from './appearance.js';
import { foliateStyles } from './foliate.js';
import { DEFAULT_SETTINGS } from './settings.js';

describe('foliate appearance styles', () => {
	for (const preset of BACKGROUNDS) {
		it(`applies ${preset.id} colours and tone without overriding links`, () => {
			const styles = foliateStyles(withBackground({
				...DEFAULT_SETTINGS, font: 'system', size: 130, spacing: 1.8
			}, preset.id));
			expect(styles).toContain(`background: ${preset.page} !important`);
			expect(styles).toContain(`color: ${preset.text} !important`);
			expect(styles).toContain(`color-scheme: ${preset.tone}`);
			expect(styles).toContain('font-family: system-ui');
			expect(styles).toContain('font-size: 130%');
			expect(styles).toContain('line-height: 1.8');
			expect(styles).not.toMatch(/\ba\s*[{,]/);
		});
	}
});
