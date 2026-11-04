import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function git(root, ...args) {
	try {
		return execFileSync('git', ['--no-pager', ...args], {
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
			stdio: ['ignore', 'pipe', 'pipe']
		});
	} catch (error) {
		const detail = error.stderr?.toString().trim() || error.message;
		throw new Error(`Cannot resolve build provenance with Git ${args[0]}: ${detail}`, { cause: error });
	}
}

function samePath(first, second) {
	const normalize = (value) => {
		const path = realpathSync(value);
		return process.platform === 'win32' ? path.toLowerCase() : path;
	};
	return normalize(first) === normalize(second);
}

export function resolveProvenance(root = projectRoot, release = '') {
	const top = git(root, 'rev-parse', '--show-toplevel').trim();
	if (!samePath(root, top)) {
		throw new Error('Build source directory must be the root of its Git checkout.');
	}
	const fields = git(root, 'show', '-s', '--no-show-signature', '--format=%H%n%cI', 'HEAD').trim().split(/\r?\n/);
	if (fields.length !== 2 || fields.some((field) => !field)) {
		throw new Error('Git returned incomplete commit provenance.');
	}
	const dirty = git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=normal') ? 'true' : 'false';
	const head = git(root, 'rev-parse', '--verify', 'HEAD').trim();
	if (head !== fields[0]) {
		throw new Error('HEAD changed while resolving build provenance.');
	}
	if (release) {
		const tagged = git(root, 'rev-parse', '--verify', `refs/tags/${release}^{commit}`).trim();
		if (tagged !== head) throw new Error('The requested release tag does not point to HEAD.');
	}
	return { commit: fields[0], commitDate: fields[1], dirty, release };
}

export function parseOptions(args, kind) {
	const target = kind === 'container' ? '--tag' : '--output';
	const values = new Map();
	for (let index = 0; index < args.length; index++) {
		const option = args[index];
		if (option !== target && option !== '--release') {
			throw new Error(`Unknown option ${option}. Expected ${target} and optional --release.`);
		}
		if (values.has(option) || index + 1 >= args.length || !args[index + 1]) {
			throw new Error(`${option} must be supplied once with a non-empty value.`);
		}
		values.set(option, args[++index]);
	}
	const output = values.get(target) ?? (kind === 'container' ? 'pandalibrary:dev' : '');
	if (!output) throw new Error(`${target} is required.`);
	return { output, release: values.get('--release') ?? '' };
}

export function stampArgs(stamp) {
	return ['-commit', stamp.commit, '-date', stamp.commitDate, '-dirty', stamp.dirty, '-release', stamp.release];
}

export function linkerFlags(stamp) {
	return [
		'-s', '-w',
		`-X pandalibrary/internal/buildinfo.stampCommit=${stamp.commit}`,
		`-X pandalibrary/internal/buildinfo.stampCommitDate=${stamp.commitDate}`,
		`-X pandalibrary/internal/buildinfo.stampDirty=${stamp.dirty}`,
		`-X pandalibrary/internal/buildinfo.stampRelease=${stamp.release}`
	].join(' ');
}

export function runChecked(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit', ...options });
	if (result.error) throw new Error(`Cannot run ${command}: ${result.error.message}`, { cause: result.error });
	if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status}).`);
}

export function isMain(moduleURL) {
	return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(moduleURL);
}
