import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Book rendering keeps browser state across files, so reader specs run one at a time.
export default defineConfig({
	...base,
	workers: 1,
	testIgnore: ['**/pdf/ocr/ocr.e2e.ts'],
	testMatch: ['src/lib/reader/**/*.e2e.{ts,js}', 'src/routes/read/**/*.e2e.{ts,js}']
});
