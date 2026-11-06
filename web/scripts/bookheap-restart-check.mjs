// Bookheap restart check: queues heap assignments, stops the server while they are being
// imported, restarts it on the same data directory, and verifies the heap, import jobs,
// library, shelf and heap folder end up consistent. Usage:
//   $env:PANDA_E2E_BINARY = (Resolve-Path .\pandalibrary.exe).Path
//   node web/scripts/bookheap-restart-check.mjs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { crc32 } from 'node:zlib';
import { randomUUID } from 'node:crypto';

const binary = process.env.PANDA_E2E_BINARY;
if (!binary) throw new Error('PANDA_E2E_BINARY is required');

const count = 150;
const dataDir = await mkdtemp(join(tmpdir(), 'pandalibrary-bookheap-restart-'));
const heapDir = join(dataDir, 'bookheap');
const slowTags = Array.from({ length: 10_000 }, (_, index) => `<dc:subject>Restart tag ${index}</dc:subject>`).join('');
const logs = [];
let active;

function zip(entries) {
	const local = [];
	const central = [];
	let offset = 0;
	for (const [path, content] of Object.entries(entries)) {
		const name = Buffer.from(path);
		const data = Buffer.from(content);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt32LE(crc32(data), 14);
		header.writeUInt32LE(data.length, 18);
		header.writeUInt32LE(data.length, 22);
		header.writeUInt16LE(name.length, 26);
		local.push(header, name, data);
		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50, 0);
		directory.writeUInt16LE(20, 4);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt32LE(crc32(data), 16);
		directory.writeUInt32LE(data.length, 20);
		directory.writeUInt32LE(data.length, 24);
		directory.writeUInt16LE(name.length, 28);
		directory.writeUInt32LE(offset, 42);
		central.push(directory, name);
		offset += header.length + name.length + data.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(entries).length, 8);
	end.writeUInt16LE(Object.keys(entries).length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}

function epub(title, slow = false) {
	return zip({
		mimetype: 'application/epub+zip',
		'META-INF/container.xml': `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
		'book.opf': `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><dc:identifier id="id" opf:scheme="uuid">urn:uuid:${randomUUID()}</dc:identifier><dc:title>${title}</dc:title><dc:language>en</dc:language>${slow ? slowTags : ''}</metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>`,
		'nav.xhtml': `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="one.xhtml">One</a></li></ol></nav></body></html>`,
		'one.xhtml': `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><p>${title}</p></body></html>`
	});
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

async function start() {
	const port = await unusedPort();
	const origin = `http://127.0.0.1:${port}`;
	let lineBuffer = '';
	let setupToken;
	let spawnError;
	const child = spawn(binary, ['serve'], {
		env: {
			...process.env,
			PANDA_DATA_DIR: dataDir,
			PANDA_LISTEN: `127.0.0.1:${port}`,
			PANDA_BASE_URL: origin,
			PANDA_DROP_DIR: join(dataDir, 'drop'),
			PANDA_DROP_POLL: '0',
			PANDA_AUTO_MIGRATE: 'true',
			PANDA_LOG_LEVEL: 'info',
			PANDA_TRUSTED_PROXIES: ''
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	active = child;
	child.on('error', (error) => { spawnError = error; });
	const append = (chunk) => {
		lineBuffer += chunk.toString();
		const lines = lineBuffer.split(/\r?\n/);
		lineBuffer = lines.pop() ?? '';
		for (const line of lines) {
			logs.push(line);
			if (logs.length > 600) logs.shift();
			setupToken ??= line.match(/"setup_token"\s*:\s*"([^"]+)"/)?.[1];
		}
	};
	child.stdout.on('data', append);
	child.stderr.on('data', append);
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (spawnError) throw spawnError;
		if (child.exitCode !== null || child.signalCode !== null) throw new Error('server exited before readiness');
		try {
			const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) });
			if (response.ok) return { child, origin, setupToken };
		} catch {
			// Connection failures are expected while the server starts.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error('server did not become healthy within 60 seconds');
}

async function stop(server, signal = 'SIGTERM') {
	if (server.child.exitCode !== null || server.child.signalCode !== null) return;
	const exited = new Promise((resolve) => server.child.once('exit', resolve));
	server.child.kill(signal);
	const forceKill = setTimeout(() => server.child.kill('SIGKILL'), 20_000);
	try {
		await exited;
	} finally {
		clearTimeout(forceKill);
	}
	if (active === server.child) active = undefined;
}

function client(server, cookie) {
	return async (path, { method = 'GET', body, expect = [200] } = {}) => {
		const headers = { Origin: server.origin };
		if (cookie) headers.Cookie = cookie;
		if (body !== undefined) headers['Content-Type'] = 'application/json';
		const response = await fetch(`${server.origin}${path}`, {
			method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000)
		});
		if (!expect.includes(response.status)) {
			throw new Error(`${method} ${path} returned ${response.status}: ${await response.text()}`);
		}
		return response;
	};
}

async function signIn(server) {
	const call = client(server);
	const response = server.setupToken
		? await call('/api/v1/setup', { method: 'POST', expect: [200, 201], body: {
			token: server.setupToken, username: 'restart-admin', display_name: 'Restart Admin', password: 'restart-test-password', locale: 'en'
		} })
		: await call('/api/v1/auth/login', { method: 'POST', body: { username: 'restart-admin', password: 'restart-test-password' } });
	const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
	if (!cookie) throw new Error('sign-in did not return a session cookie');
	return client(server, cookie);
}

async function json(call, path, options) {
	return (await call(path, options)).json();
}

async function heapItems(call) {
	const items = [];
	let cursor = null;
	do {
		const page = await json(call, `/api/v1/admin/bookheap/items?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
		items.push(...page.items);
		cursor = page.next_cursor;
	} while (cursor);
	return items;
}

async function scan(call) {
	await call('/api/v1/admin/bookheap/scan', { method: 'POST', expect: [200, 202] });
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const { scan } = await json(call, '/api/v1/admin/bookheap/scan');
		if (scan?.status === 'completed') return scan;
		if (scan?.status === 'failed') throw new Error(`scan failed: ${scan.error}`);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error('scan did not finish within 60 seconds');
}

async function all(call, path) {
	const items = [];
	let cursor = null;
	do {
		const separator = path.includes('?') ? '&' : '?';
		const page = await json(call, `${path}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
		items.push(...page.items);
		cursor = page.next_cursor;
	} while (cursor);
	return items;
}

async function bookheapJobs(call) {
	return (await all(call, '/api/v1/imports')).filter((job) => job.source === 'bookheap');
}

function unfinishedJobsOnDisk() {
	const database = new DatabaseSync(join(dataDir, 'pandalibrary.db'), { readOnly: true });
	try {
		const row = database.prepare(`SELECT count(*) AS count FROM import_jobs
			WHERE source = 'bookheap' AND status IN ('pending', 'processing')`).get();
		return Number(row.count);
	} finally {
		database.close();
	}
}

async function waitSettled(call) {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		const items = await heapItems(call);
		const jobs = await bookheapJobs(call);
		const busy = items.some((item) => item.status === 'queued' || item.status === 'importing') ||
			jobs.some((job) => job.status === 'pending' || job.status === 'processing');
		if (!busy) return { items, jobs };
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error('bookheap assignments did not settle within 90 seconds after the restart');
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

try {
	await mkdir(join(heapDir, 'restart'), { recursive: true });
	const settled = new Date(Date.now() - 60_000);
	for (let index = 1; index <= count; index += 1) {
		const path = join(heapDir, 'restart', `Restart ${String(index).padStart(2, '0')}.epub`);
		await writeFile(path, epub(`Restart Book ${index}`, index === 1));
		await utimes(path, settled, settled);
	}

	let server = await start();
	let call = await signIn(server);
	const { library } = await json(call, '/api/v1/admin/libraries', { method: 'POST', expect: [201], body: { name: 'Restart Library', slug: 'restart-library' } });
	const { shelf } = await json(call, '/api/v1/shelves', { method: 'POST', expect: [201], body: { kind: 'private', name: 'Restart Shelf', description: null } });
	const summary = await scan(call);
	assert(summary.added === count, `scan added ${summary.added}, expected ${count}`);
	const indexed = await heapItems(call);
	const slow = indexed.find((item) => item.rel_path === 'restart/Restart 01.epub');
	assert(slow && indexed.length === count, `expected ${count} indexed items including the slow fixture`);
	const ids = [slow.id, ...indexed.filter((item) => item.id !== slow.id).map((item) => item.id)];

	// The large metadata fixture keeps an import active long enough to exercise crash recovery.
	let crashStarted = false;
	let assignmentError;
	const assigning = call('/api/v1/admin/bookheap/assign', {
		method: 'POST', expect: [202], body: { ids, library_id: library.id, shelf_ids: [shelf.id] }
	}).then(
		() => ({ state: 'completed' }),
		(error) => {
			if (!crashStarted) assignmentError = error;
			return { state: 'interrupted', error, crashStarted };
		}
	);
	let snapshot = [];
	let unfinished = 0;
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		snapshot = await bookheapJobs(call);
		if (assignmentError) throw assignmentError;
		unfinished = snapshot.filter((job) => job.status === 'pending' || job.status === 'processing').length;
		if (unfinished > 0 || snapshot.length === count) break;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert(unfinished > 0, `no pending or processing job was observed among ${snapshot.length} assignments`);
	crashStarted = true;
	await stop(server, 'SIGKILL');
	const request = await assigning;
	if (request.state === 'interrupted' &&
		(!request.crashStarted || !(request.error instanceof TypeError) || request.error.message !== 'fetch failed')) {
		throw request.error;
	}
	unfinished = unfinishedJobsOnDisk();
	assert(unfinished > 0, 'no pending or processing job remained on disk at the crash');
	console.log(`Stopped the server with ${snapshot.length} of ${count} items queued; ${unfinished} jobs were pending or processing on disk, and the assign request ${request.state}.`);

	server = await start();
	call = await signIn(server);
	let { items, jobs } = await waitSettled(call);
	const failures = [...new Set(jobs.filter((job) => job.status === 'failed').map((job) => job.error))];
	if (failures.length > 0) console.log(`Failed jobs after the restart: ${JSON.stringify(failures)}`);
	for (const item of items) {
		assert(item.status === 'ready' || item.status === 'failed', `item ${item.id} ended as ${item.status}`);
		assert(existsSync(join(heapDir, ...item.rel_path.split('/'))), `the file of heap item ${item.id} is missing`);
	}
	let imported = jobs.filter((job) => job.status === 'imported').length;
	assert(imported + items.length === count, `${imported} imported + ${items.length} left in the heap != ${count}`);
	const resumed = items.length;

	// Items the interrupted request never queued, and failed ones, can be assigned after the restart.
	if (items.length > 0) {
		const { results } = await json(call, '/api/v1/admin/bookheap/assign', {
			method: 'POST', expect: [202], body: { ids: items.map((item) => item.id), library_id: library.id, shelf_ids: [shelf.id] }
		});
		assert(results.every((result) => result.ok), `reassignment rejected items: ${JSON.stringify(results.filter((result) => !result.ok))}`);
		({ items, jobs } = await waitSettled(call));
	}

	assert(items.length === 0, `items still in the heap: ${JSON.stringify(items.map((item) => [item.rel_path, item.status, item.error]))}`);
	const files = await readdir(join(heapDir, 'restart'));
	assert(files.length === 0, `heap folder still holds ${JSON.stringify(files)}`);
	imported = jobs.filter((job) => job.status === 'imported').length;
	assert(imported === count, `${imported} jobs imported, expected ${count}`);
	const books = await all(call, `/api/v1/books?library_id=${library.id}`);
	const shelfBooks = await all(call, `/api/v1/shelves/${shelf.id}/books`);
	assert(books.length === count, `library has ${books.length} books, expected ${count}`);
	assert(shelfBooks.length === count, `shelf has ${shelfBooks.length} books, expected ${count}`);
	const manifests = existsSync(join(dataDir, 'tmp', 'imports')) ? await readdir(join(dataDir, 'tmp', 'imports')) : [];
	assert(manifests.length === 0, `import manifests left behind: ${manifests.join(', ')}`);
	const rescan = await scan(call);
	assert(rescan.added === 0 && rescan.removed === 0, `rescan changed the heap: ${JSON.stringify(rescan)}`);
	await stop(server);
	console.log(`Bookheap restart check passed: ${unfinished} imports were in flight at the restart and ${resumed} items were assigned again afterwards; all ${count} books are in the library and on the shelf, and the heap folder and index are empty.`);
} catch (error) {
	if (active) await stop({ child: active });
	console.error(`${error.message}\n${logs.join('\n')
		.replace(/("(?:setup_token|password|token)"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2')}`);
	process.exitCode = 1;
} finally {
	await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
