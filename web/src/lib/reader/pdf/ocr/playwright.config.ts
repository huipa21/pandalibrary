import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: '.',
	testMatch: 'ocr.e2e.ts',
	workers: 1,
	use: { actionTimeout: 10_000 }
});
