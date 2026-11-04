import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { argon2Sync } from 'node:crypto';
import { promisify } from 'node:util';

const candidate = process.env.PANDA_CANDIDATE_BINARY;
const previous = process.env.PANDA_PREVIOUS_BINARY;
if (!candidate) throw new Error('PANDA_CANDIDATE_BINARY is required');

const dataDir = await mkdtemp(join(tmpdir(), 'pandalibrary-upgrade-'));
const logs = new Map();
let active;
const execute = promisify(execFile);

async function createBaseline() {
	const migration = await readFile(new URL('../../internal/db/migrations/00001_init.sql', import.meta.url), 'utf8');
	const schema = migration.split('-- +goose Up')[1]?.split('-- +goose Down')[0];
	if (!schema) throw new Error('initial migration does not contain a v1 schema');
	const database = new DatabaseSync(join(dataDir, 'pandalibrary.db'));
	try {
		database.exec(schema);
		database.exec(`
			CREATE TABLE goose_db_version (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				version_id INTEGER NOT NULL,
				is_applied INTEGER NOT NULL,
				tstamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			);
			INSERT INTO goose_db_version (version_id, is_applied) VALUES (0, 1), (1, 1);
		`);
		const salt = Buffer.from('upgrade-fixture!');
		const key = argon2Sync('argon2id', {
			message: 'upgrade-test-password', nonce: salt,
			parallelism: 4, tagLength: 32, memory: 65536, passes: 3
		});
		const hash = `$argon2id$v=19$m=65536,t=3,p=4$${salt.toString('base64').replace(/=+$/, '')}$${key.toString('base64').replace(/=+$/, '')}`;
		database.prepare(`
			INSERT INTO users (username, display_name, password_hash, role, locale, created_at, updated_at)
			VALUES (?, ?, ?, 'admin', 'en', 1700000000000, 1700000000000)
		`).run('upgrade-admin', 'Upgrade Admin', hash);
		database.exec(`
			INSERT INTO libraries (name, slug, created_at, updated_at)
			VALUES ('Upgrade Fixture', 'upgrade-fixture', 1700000000000, 1700000000000);
		`);
	} finally {
		database.close();
	}
}

function safeLogs(binary) {
	return (logs.get(binary) ?? '')
		.replace(/("(?:setup_token|password|api_token|secret|token)"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2')
		.replace(/(setup_token=)[^\s,"]+/gi, '$1[redacted]');
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

async function start(binary, requireSetup = false) {
	const port = await unusedPort();
	const origin = `http://127.0.0.1:${port}`;
	const output = [];
	let lineBuffer = '';
	let setupToken;
	const child = spawn(binary, ['serve'], {
		env: {
			...process.env,
			PANDA_DATA_DIR: dataDir,
			PANDA_LISTEN: `127.0.0.1:${port}`,
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
	active = child;
	let spawnError;
	child.on('error', (error) => {
		spawnError = error;
		if (active === child) active = undefined;
	});
	const append = (chunk) => {
		lineBuffer += chunk.toString();
		const lines = lineBuffer.split(/\r?\n/);
		lineBuffer = lines.pop() ?? '';
		for (const line of lines) {
			output.push(line);
			setupToken ??= line.match(/"setup_token"\s*:\s*"([^"]+)"/)?.[1];
		}
		logs.set(binary, output.slice(-400).join('\n'));
	};
	child.stdout.on('data', append);
	child.stderr.on('data', append);

	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (spawnError) throw spawnError;
		if (child.exitCode !== null || child.signalCode !== null) throw new Error('server exited before readiness');
		try {
			const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) });
			if (response.ok && (!requireSetup || setupToken)) return { child, origin, setupToken };
		} catch {
			// Connection failures are expected while the server starts.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error('server did not become healthy within 60 seconds');
}

async function stop(server) {
	if (server.child.exitCode !== null || server.child.signalCode !== null) return;
	const exited = new Promise((resolve, reject) => {
		server.child.once('exit', resolve);
		server.child.once('error', reject);
	});
	server.child.kill('SIGTERM');
	const forceKill = setTimeout(() => server.child.kill('SIGKILL'), 20_000);
	try {
		await exited;
	} finally {
		clearTimeout(forceKill);
	}
	if (active === server.child) active = undefined;
}

async function request(origin, path, options = {}) {
	const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(10_000), ...options });
	if (!response.ok) {
		throw new Error(`${options.method ?? 'GET'} ${path} failed with ${response.status}: ${await response.text()}`);
	}
	return response;
}

async function bootstrap(server) {
	if (!server.setupToken) throw new Error('prior-version startup did not provide first-run setup');
	const response = await request(server.origin, '/api/v1/setup', {
		method: 'POST',
		headers: { Origin: server.origin, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			token: server.setupToken,
			username: 'upgrade-admin',
			display_name: 'Upgrade Admin',
			password: 'upgrade-test-password',
			locale: 'en'
		})
	});
	const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
	if (!cookie) throw new Error('first-run setup did not return a session cookie');
	await request(server.origin, '/api/v1/admin/libraries', {
		method: 'POST',
		headers: { Origin: server.origin, Cookie: cookie, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Upgrade Fixture', slug: 'upgrade-fixture' })
	});
}

try {
	if (!previous) {
		console.log('No prior release artifact is available; generating the initial v1 database baseline.');
		await createBaseline();
	} else {
		const source = await start(previous, true);
		await bootstrap(source);
		await stop(source);
	}

	const upgraded = await start(candidate);
	const login = await request(upgraded.origin, '/api/v1/auth/login', {
		method: 'POST',
		headers: { Origin: upgraded.origin, 'Content-Type': 'application/json' },
		body: JSON.stringify({ username: 'upgrade-admin', password: 'upgrade-test-password' })
	});
	const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
	if (!cookie) throw new Error('candidate login did not return a session cookie');
	const response = await request(upgraded.origin, '/api/v1/admin/libraries?limit=50', {
		headers: { Cookie: cookie }
	});
	const payload = await response.json();
	if (!payload.items?.some((library) => library.name === 'Upgrade Fixture')) {
		throw new Error('pre-existing library was not usable after candidate startup');
	}
	await stop(upgraded);
	const { stdout } = await execute(candidate, ['migrate', 'status'], {
		env: { ...process.env, PANDA_DATA_DIR: dataDir }, timeout: 20_000
	});
	if (!stdout.includes('Status: up to date')) throw new Error(`startup migrations remain pending: ${stdout}`);
	console.log('Upgrade check passed: candidate startup is healthy and retained the prior library.');
} catch (error) {
	if (active) await stop({ child: active });
	const output = [...logs.entries()].map(([binary]) => safeLogs(binary)).filter(Boolean).join('\n');
	console.error(`${error.message}${output ? `\n${output}` : ''}`);
	process.exitCode = 1;
} finally {
	await rm(dataDir, { recursive: true, force: true });
}
