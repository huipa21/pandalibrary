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
	workers: realServer ? 1 : undefined,
	globalSetup: realServer ? './scripts/e2e-server.mjs' : undefined,
	webServer: realServer
		? undefined
		: {
				command: 'pnpm build && pnpm preview --host 127.0.0.1',
				url: origin,
				reuseExistingServer: !process.env.CI
			},
	use: { baseURL: origin, actionTimeout: 10_000, navigationTimeout: 20_000 },
	testMatch: '**/*.e2e.{ts,js}'
});
