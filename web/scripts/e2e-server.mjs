import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function sanitize(value) {
	return value
		.replace(/("(?:setup_token|password|api_token|secret|token)"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2')
		.replace(/(setup_token=)[^\s,"]+/gi, '$1[redacted]')
		.replace(/(password|token)=([^\s,"]+)/gi, '$1=[redacted]');
}

export default async function setup(config) {
	const binary = process.env.PANDA_E2E_BINARY;
	const tokenFile = process.env.PANDA_E2E_SETUP_TOKEN_FILE;
	const dataDir = process.env.PANDA_E2E_DATA_DIR;
	if (!binary || !tokenFile || !dataDir) {
		throw new Error('PANDA_E2E_BINARY, setup-token, and data paths are required');
	}

	const address = `127.0.0.1:${process.env.PANDA_E2E_PORT}`;
	const origin = `http://${address}`;
	await mkdir(dataDir);
	const logs = [];
	let lineBuffer = '';
	let setupToken;
	let spawnError;
	const child = spawn(binary, ['serve'], {
		env: {
			...process.env,
			PANDA_DATA_DIR: dataDir,
			PANDA_LISTEN: address,
			PANDA_BASE_URL: origin,
			PANDA_DROP_DIR: join(dataDir, 'drop'),
			PANDA_DROP_POLL: '0',
			PANDA_AUTO_MIGRATE: 'true',
			PANDA_MIGRATE_BACKUP: 'true',
			PANDA_LOG_LEVEL: 'info',
			PANDA_TRUSTED_PROXIES: ''
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	child.on('error', (error) => { spawnError = error; });
	const closed = new Promise((resolve) => child.once('close', resolve));

	function collect(chunk) {
		lineBuffer += chunk.toString();
		const lines = lineBuffer.split(/\r?\n/);
		lineBuffer = lines.pop() ?? '';
		for (const line of lines) {
			logs.push(line);
			if (logs.length > 400) logs.shift();
			const match = line.match(/"setup_token"\s*:\s*"([^"]+)"/);
			if (match) setupToken = match[1];
		}
	}
	child.stdout.on('data', collect);
	child.stderr.on('data', collect);

	async function stop() {
		if (!spawnError && child.exitCode === null && child.signalCode === null) {
			child.kill('SIGTERM');
		}
		const forceKill = setTimeout(() => child.kill('SIGKILL'), 20_000);
		try {
			await closed;
		} finally {
			clearTimeout(forceKill);
		}
		await Promise.all([
			rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }),
			rm(tokenFile, { force: true })
		]);
	}

	async function waitUntilReady() {
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			if (spawnError) throw spawnError;
			if (child.exitCode !== null || child.signalCode !== null) {
				throw new Error('server exited before readiness');
			}
			let response;
			try {
				response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) });
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 250));
				continue;
			}
			if (response.ok && setupToken) {
				await writeFile(tokenFile, setupToken, { mode: 0o600 });
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error('server did not become healthy with first-run setup within 60 seconds');
	}

	try {
		await waitUntilReady();
	} catch (error) {
		console.error(`${error.message}\n${sanitize(logs.join('\n'))}`);
		await stop();
		throw error;
	}

	return async () => {
		const exited = child.exitCode !== null || child.signalCode !== null;
		await stop();
		const outputDir = config.projects[0].outputDir;
		await mkdir(outputDir, { recursive: true });
		await writeFile(join(outputDir, 'server.log'), sanitize(logs.join('\n')));
		if (exited) throw new Error('E2E server exited unexpectedly; see test-results/server.log');
	};
}
