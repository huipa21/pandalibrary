import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const config = fileURLToPath(new URL('../src/lib/buildinfo/vite.harness.config.mjs', import.meta.url));
const listener = createServer();
await new Promise((resolve, reject) => {
	listener.once('error', reject);
	listener.listen(0, '127.0.0.1', resolve);
});
const address = listener.address();
if (!address || typeof address === 'string') throw new Error('Cannot allocate a browser test port');
const port = address.port;
await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));

const origin = `http://127.0.0.1:${port}`;
const fixture = `${origin}/src/lib/buildinfo/BuildVersion.harness.html`;
const server = spawn(process.execPath, [
	vite, '--config', config, '--host', '127.0.0.1', '--port', String(port), '--strictPort'
], {
	cwd: webRoot,
	stdio: ['ignore', 'pipe', 'pipe']
});
let serverOutput = '';
let serverError;
server.stdout.on('data', (data) => { serverOutput += data.toString(); });
server.stderr.on('data', (data) => { serverOutput += data.toString(); });
server.once('error', (error) => { serverError = error; });
let browser;

const info = {
	version: '20251231-150045+0123456789ab-dirty',
	commit: '0123456789abcdef0123456789abcdef01234567',
	commit_date: '2025-12-31T15:00:45Z',
	dirty: true,
	release: 'v1.2.3'
};

try {
	const deadline = Date.now() + 60_000;
	let ready = false;
	while (Date.now() < deadline) {
		if (serverError || server.exitCode !== null) throw new Error(`Vite exited: ${serverError?.message || serverOutput}`);
		try {
			const response = await fetch(fixture, { signal: AbortSignal.timeout(1000) });
			if (response.ok && (await response.text()).includes('version-root')) {
				ready = true;
				break;
			}
		} catch (error) {
			if (!(error instanceof TypeError) && error.name !== 'TimeoutError') throw error;
		}
		await delay(250);
	}
	if (!ready) throw new Error(`Vite did not become ready: ${serverOutput}`);

	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext();
	await context.addCookies([{ name: 'ux9-private', value: 'must-not-send', url: origin }]);
	const page = await context.newPage();
	const pageErrors = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));

	let finishLoading;
	const loading = new Promise((resolve) => { finishLoading = resolve; });
	await page.route('**/api/v1/version', async (route) => {
		assert.equal(route.request().method(), 'GET');
		assert.equal(await route.request().headerValue('cookie'), null);
		await loading;
		await route.fulfill({ json: info });
	});
	await page.goto(fixture);
	await page.getByText('Loading version…').waitFor();
	finishLoading();
	await page.getByText(`Version ${info.version}`, { exact: true }).click();
	await page.getByText(info.commit, { exact: true }).waitFor();
	await page.locator(`time[datetime="${info.commit_date}"]`).waitFor();
	await page.getByText(info.release, { exact: true }).waitFor();

	await page.unroute('**/api/v1/version');
	let offlineRequests = 0;
	await page.route('**/api/v1/version', async (route) => {
		if (++offlineRequests === 1) await route.abort('internetdisconnected');
		else await route.fulfill({ json: info });
	});
	await page.reload();
	await page.getByText('Version unavailable while offline or unable to reach the server.').waitFor();
	await page.getByRole('button', { name: 'Retry' }).click();
	await page.getByText(`Version ${info.version}`, { exact: true }).waitFor();
	assert.equal(offlineRequests, 2);

	await page.unroute('**/api/v1/version');
	let failedRequests = 0;
	await page.route('**/api/v1/version', async (route) => {
		failedRequests++;
		if (failedRequests === 1) {
			await route.fulfill({ status: 503, contentType: 'application/problem+json', body: '{"status":503}' });
		} else if (failedRequests === 2) {
			await route.fulfill({ json: { version: 'invalid' } });
		} else {
			await route.fulfill({ json: info });
		}
	});
	await page.reload();
	await page.getByText('Could not load build version.').waitFor();
	await page.getByRole('button', { name: 'Retry' }).click();
	await page.getByText('Could not load build version.').waitFor();
	await page.getByRole('button', { name: 'Retry' }).click();
	await page.getByText(`Version ${info.version}`, { exact: true }).waitFor();
	assert.equal(failedRequests, 3);

	await page.unroute('**/api/v1/version');
	let onlineRequests = 0;
	await page.route('**/api/v1/version', async (route) => {
		if (++onlineRequests === 1) await route.abort('internetdisconnected');
		else await route.fulfill({ json: info });
	});
	await page.reload();
	await page.getByText('Version unavailable while offline or unable to reach the server.').waitFor();
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	await page.getByText(`Version ${info.version}`, { exact: true }).waitFor();
	assert.equal(onlineRequests, 2);
	assert.deepEqual(pageErrors, []);
	console.log('Build version browser checks passed: loading, accessible metadata, offline, retry, failure, and reconnect.');
} finally {
	if (browser) await browser.close();
	if (server.exitCode === null && server.signalCode === null) {
		server.kill();
		await once(server, 'exit');
	}
}
