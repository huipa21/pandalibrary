import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const realServer = process.env.PANDA_E2E_BINARY;
if (realServer && !process.env.PANDA_E2E_PORT) {
	const listener = createServer();
	await new Promise<void>((resolve, reject) => {
		listener.once('error', reject);
		listener.listen(0, '127.0.0.1', resolve);
	});
	const address = listener.address();
	if (!address || typeof address === 'string') throw new Error('Cannot allocate an E2E port');
	process.env.PANDA_E2E_PORT = String(address.port);
	await new Promise<void>((resolve, reject) =>
		listener.close((error) => error ? reject(error) : resolve())
	);
}
const origin = `http://127.0.0.1:${realServer ? process.env.PANDA_E2E_PORT : '4173'}`;
const runID = process.env.PANDA_E2E_RUN_ID ?? randomUUID();
if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(runID)) {
	throw new Error('PANDA_E2E_RUN_ID must be a UUID');
}
const tokenFile = join(tmpdir(), `pandalibrary-e2e-${runID}.token`);
const dataDir = join(tmpdir(), `pandalibrary-e2e-${runID}`);

if (realServer) {
	process.env.PANDA_E2E_RUN_ID = runID;
	process.env.PANDA_E2E_SETUP_TOKEN_FILE = tokenFile;
	process.env.PANDA_E2E_DATA_DIR = dataDir;
}

export default defineConfig({
	// The blocking gate is retry-free. Two workers limit simultaneous EPUB/PDF layout;
	// remaining failures must be fixed in the specs, not hidden with retries.
	workers: realServer ? 1 : 2,
	// Retries hide flakes. Saturation runs opt into the old four-worker, one-retry
	// budget explicitly with `test:e2e:saturation` and stay non-blocking.
	retries: 0,
	globalSetup: realServer ? './scripts/e2e-server.mjs' : undefined,
	webServer: realServer
		? undefined
		: {
				command: 'pnpm build && pnpm preview --host 127.0.0.1',
				url: origin,
				reuseExistingServer: !process.env.CI
			},
	// Pages that open a PDF or EPUB do real layout work while another worker loads its own
	// book. Under a full two-worker run the previous federation budget still measured load.
	expect: { timeout: 60_000 },
	timeout: 180_000,
	use: {
		baseURL: origin,
		launchOptions: {
			// WSL/Chromium can report ERR_NETWORK_CHANGED when the out-of-process network
			// service restarts under load. Keep it in the browser process for the gate.
			args: ['--enable-features=NetworkServiceInProcess']
		},
		actionTimeout: 60_000,
		navigationTimeout: 60_000,
		// A service worker serves requests the specs cannot route, so a stale cache makes them
		// nondeterministic. The specs that exercise offline behaviour opt back in.
		serviceWorkers: 'block'
	},
	testMatch: '**/*.e2e.{ts,js}',
	// OCR has its own config (models are large); run it with `pnpm test:e2e:ocr`.
	testIgnore: ['**/pdf/ocr/ocr.e2e.ts']
});
