import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { projectRoot, resolveProvenance } from '../../scripts/provenance.mjs';

const engine = process.env.CONTAINER_ENGINE || 'docker';
const release = process.env.RELEASE_VERSION || '';
const suffix = `${process.pid}-${Date.now()}`;
const image = `pandalibrary:check-${suffix}`;
const container = `pandalibrary-check-${suffix}`;
const volume = `pandalibrary-data-${suffix}`;
let volumeCreated = false;
let containerCreated = false;
let imageCreated = false;

function sanitize(value) {
	return value
		.replace(/("(?:setup_token|password|api_token|secret|token)"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2')
		.replace(/(setup_token=)[^\s,"]+/gi, '$1[redacted]')
		.replace(/(password|token)=([^\s,"]+)/gi, '$1=[redacted]');
}

function runCommand(command, args, { allowFailure = false, timeout = 120_000 } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout });
		const stdout = [];
		const stderr = [];
		child.stdout.on('data', (chunk) => stdout.push(chunk));
		child.stderr.on('data', (chunk) => stderr.push(chunk));
		child.once('error', reject);
		child.once('close', (code) => {
			const result = { code, stdout: Buffer.concat(stdout).toString().trim(), stderr: Buffer.concat(stderr).toString().trim() };
			if (code !== 0 && !allowFailure) {
				reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${result.stderr || result.stdout}`));
				return;
			}
			resolve(result);
		});
	});
}

function run(args, options) {
	return runCommand(engine, args, options);
}

function expectedMetadata(stamp) {
	const commitDate = new Date(stamp.commitDate).toISOString().replace('.000Z', 'Z');
	const prefix = commitDate.slice(0, 19).replaceAll('-', '').replace('T', '-').replaceAll(':', '');
	return {
		version: `${prefix}+${stamp.commit.slice(0, 12)}${stamp.dirty === 'true' ? '-dirty' : ''}`,
		commit: stamp.commit,
		commit_date: commitDate,
		dirty: stamp.dirty === 'true',
		release: stamp.release || null
	};
}

async function unusedPort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const { port } = server.address();
	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	return port;
}

async function compressedImageSize() {
	return new Promise((resolve, reject) => {
		const child = spawn(engine, ['save', image], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
		const gzip = createGzip();
		let compressedBytes = 0;
		let stderr = '';
		let gzipEnded = false;
		let childCode;
		child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
		child.once('error', reject);
		gzip.on('data', (chunk) => { compressedBytes += chunk.length; });
		gzip.once('error', reject);
		const finish = () => {
			if (childCode === undefined || !gzipEnded) return;
			if (childCode !== 0) {
				reject(new Error(`${engine} save failed (${childCode}): ${stderr.trim()}`));
				return;
			}
			resolve(compressedBytes);
		};
		gzip.once('end', () => { gzipEnded = true; finish(); });
		child.stdout.pipe(gzip);
		child.once('close', (code) => { childCode = code; finish(); });
	});
}

async function waitForHealth() {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const result = await run(['inspect', '--format', '{{json .State}}', container]);
		const state = JSON.parse(result.stdout);
		if (!state.Running) throw new Error(`container exited before becoming healthy (${state.ExitCode})`);
		const health = state.Health ?? state.Healthcheck;
		if (!health) throw new Error('container has no configured healthcheck');
		if (health.Status === 'healthy') return;
		if (health.Status === 'unhealthy') throw new Error('container healthcheck reported unhealthy');
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error('container did not become healthy within 120 seconds');
}

async function cleanup() {
	for (const args of [
		...(containerCreated ? [['rm', '--force', container]] : []),
		...(volumeCreated ? [['volume', 'rm', '--force', volume]] : []),
		...(imageCreated ? [['image', 'rm', image]] : [])
	]) {
		try {
			await run(args);
		} catch (error) {
			console.error(`Container cleanup failed: ${error.message}`);
			process.exitCode = 1;
		}
	}
}

try {
	const expected = expectedMetadata(resolveProvenance(projectRoot, release));
	const builder = fileURLToPath(new URL('../../scripts/build-container.mjs', import.meta.url));
	await runCommand(process.execPath, [
		builder, '--tag', image, ...(release ? ['--release', release] : [])
	], { timeout: 20 * 60_000 });
	imageCreated = true;
	const user = await run(['image', 'inspect', '--format', '{{.Config.User}}', image]);
	if (user.stdout !== '65532:65532') throw new Error(`image user is ${user.stdout}; expected 65532:65532`);
	const embeddedVersion = await run([
		'run', '--rm', '--env', 'PATH=/nonexistent', '--entrypoint', '/pandalibrary', image, 'version'
	]);
	const expectedCLI = expected.version + (release ? ` (release ${release})` : '');
	if (embeddedVersion.stdout !== expectedCLI) {
		throw new Error(`binary version is ${embeddedVersion.stdout}; expected ${expectedCLI}`);
	}

	const compressedBytes = await compressedImageSize();
	console.log(`Compressed image archive: ${(compressedBytes / (1024 * 1024)).toFixed(1)} MiB`);
	if (compressedBytes > 35 * 1024 * 1024) throw new Error('compressed image exceeds the 35 MiB release target');

	await run(['volume', 'create', volume]);
	volumeCreated = true;
	const port = await unusedPort();
	await run([
		'run', '--detach', '--name', container, '--publish', `127.0.0.1:${port}:8080`,
		'--volume', `${volume}:/data`, image
	]);
	containerCreated = true;
	await waitForHealth();

	const versionResponse = await fetch(`http://127.0.0.1:${port}/api/v1/version`, {
		cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10_000)
	});
	if (!versionResponse.ok || versionResponse.headers.get('cache-control') !== 'no-store') {
		throw new Error(`public version endpoint failed (${versionResponse.status})`);
	}
	assert.deepEqual(await versionResponse.json(), expected, 'container HTTP provenance differs from the checkout');

	const setupPage = await fetch(`http://127.0.0.1:${port}/setup`, { signal: AbortSignal.timeout(10_000) });
	if (!setupPage.ok || !(await setupPage.text()).includes('<html')) {
		throw new Error(`/setup did not return the embedded application (${setupPage.status})`);
	}
	const setupStatus = await fetch(`http://127.0.0.1:${port}/api/v1/setup`, { signal: AbortSignal.timeout(10_000) });
	const setup = await setupStatus.json();
	if (!setupStatus.ok || setup.required !== true) throw new Error('fresh persistent data directory did not require first-run setup');

	const unavailable = await run([
		'run', '--rm', '--entrypoint', '/pandalibrary', image,
		'healthcheck', '--listen', '127.0.0.1:1'
	], { allowFailure: true });
	if (unavailable.code === 0) throw new Error('binary healthcheck succeeded while the service was unavailable');

	await run(['stop', '--time', '20', container]);
	const exitCode = await run(['inspect', '--format', '{{.State.ExitCode}}', container]);
	if (exitCode.stdout !== '0') throw new Error(`SIGTERM shutdown exited with code ${exitCode.stdout}`);
	const migrations = await run([
		'run', '--rm', '--volume', `${volume}:/data`, '--env', 'PANDA_DATA_DIR=/data',
		'--entrypoint', '/pandalibrary', image, 'migrate', 'status'
	]);
	if (!migrations.stdout.includes('Status: up to date')) {
		throw new Error(`startup migrations did not finish: ${migrations.stdout}`);
	}
	console.log(`Container checks passed: ${expectedCLI}; public version, migrations, health, setup, unhealthy detection, and SIGTERM shutdown.`);
} catch (error) {
	console.error(error.message);
	if (containerCreated) {
		const result = await run(['logs', container], { allowFailure: true });
		if (result.stdout || result.stderr) console.error(sanitize(`${result.stdout}\n${result.stderr}`));
	}
	process.exitCode = 1;
} finally {
	await cleanup();
}
