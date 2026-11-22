import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Reader specs get their own single-worker invocation; this half stays two-wide.
export default defineConfig({
	...base,
	workers: 2,
	testIgnore: ['**/pdf/ocr/ocr.e2e.ts', 'src/lib/reader/**', 'src/routes/read/**']
});
