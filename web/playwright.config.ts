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
	// One preview server serves every worker, so cap the fan-out; more workers mostly
	// adds timeouts on the heavier reader specs.
	workers: realServer ? 1 : 4,
	// A single preview server plus 4 browsers makes a few heavy reader specs miss their
	// action timeout on a loaded machine; one retry separates that from real failures.
	retries: realServer ? 0 : 1,
	globalSetup: realServer ? './scripts/e2e-server.mjs' : undefined,
	webServer: realServer
		? undefined
		: {
				command: 'pnpm build && pnpm preview --host 127.0.0.1',
				url: origin,
				reuseExistingServer: !process.env.CI
			},
	// Pages that open a PDF or EPUB do real layout work while other workers load their own
	// books, so a 5s assertion budget mostly measured machine load.
	expect: { timeout: 15_000 },
	timeout: 60_000,
	use: {
		baseURL: origin,
		actionTimeout: 15_000,
		navigationTimeout: 20_000,
		// A service worker serves requests the specs cannot route, so a stale cache makes them
		// nondeterministic. The specs that exercise offline behaviour opt back in.
		serviceWorkers: 'block'
	},
	testMatch: '**/*.e2e.{ts,js}',
	// OCR has its own config (models are large); run it with `pnpm test:e2e:ocr`.
	testIgnore: ['**/pdf/ocr/ocr.e2e.ts']
});
