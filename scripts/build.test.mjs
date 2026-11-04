import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { containerBuildArgs } from './build-container.mjs';
import { linkerFlags, parseOptions, resolveProvenance, stampArgs } from './provenance.mjs';

const temporary = mkdtempSync(join(tmpdir(), 'pandalibrary build test '));
const emptyConfig = join(temporary, 'global.gitconfig');
writeFileSync(emptyConfig, '');
after(() => rmSync(temporary, { recursive: true, force: true }));

function git(root, ...args) {
	return execFileSync('git', args, {
		cwd: root,
		encoding: 'utf8',
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CONFIG_GLOBAL: emptyConfig,
			GIT_AUTHOR_NAME: 'Fixture',
			GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
			GIT_COMMITTER_NAME: 'Fixture',
			GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
			GIT_AUTHOR_DATE: '2026-01-01T00:30:45+09:30',
			GIT_COMMITTER_DATE: '2026-01-01T00:30:45+09:30'
		}
	}).trim();
}

test('resolves clean, dirty, tagged, and shallow checkouts with spaces', () => {
	const origin = join(temporary, 'source with spaces');
	mkdirSync(origin);
	git(origin, 'init', '--quiet');
	writeFileSync(join(origin, 'tracked.txt'), 'first\n');
	git(origin, 'add', 'tracked.txt');
	git(origin, 'commit', '--quiet', '-m', 'first');
	git(origin, 'tag', 'old');
	writeFileSync(join(origin, 'tracked.txt'), 'second\n');
	git(origin, 'add', 'tracked.txt');
	git(origin, 'commit', '--quiet', '-m', 'second');
	git(origin, 'tag', 'v1.2.3');

	const clone = join(temporary, 'shallow checkout');
	git(temporary, 'clone', '--quiet', '--depth=1', pathToFileURL(origin).href, clone);
	assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'true');
	const expected = {
		commit: git(clone, 'rev-parse', 'HEAD'),
		commitDate: '2026-01-01T00:30:45+09:30',
		dirty: 'false',
		release: 'v1.2.3'
	};
	assert.deepEqual(resolveProvenance(clone, 'v1.2.3'), expected);
	writeFileSync(join(clone, 'untracked.txt'), 'dirty');
	assert.deepEqual(resolveProvenance(clone), { ...expected, dirty: 'true', release: '' });
	assert.throws(() => resolveProvenance(origin, 'old'), /does not point to HEAD/);
	assert.throws(() => resolveProvenance(join(origin, '.git')), /Git|checkout root/);
});

test('passes the same raw stamp to Go and Docker without formatting a version', () => {
	const stamp = { commit: 'a'.repeat(40), commitDate: '2026-01-01T00:30:45+09:30', dirty: 'true', release: 'v1.2.3' };
	assert.deepEqual(stampArgs(stamp), [
		'-commit', stamp.commit, '-date', stamp.commitDate, '-dirty', 'true', '-release', 'v1.2.3'
	]);
	assert.match(linkerFlags(stamp), /stampCommitDate=2026-01-01T00:30:45\+09:30/);
	assert.deepEqual(containerBuildArgs('podman', 'pandalibrary:test', stamp, 'a path'), [
		'build', '--format', 'docker',
		'--build-arg', `COMMIT=${stamp.commit}`,
		'--build-arg', `COMMIT_DATE=${stamp.commitDate}`,
		'--build-arg', 'DIRTY=true',
		'--build-arg', 'RELEASE=v1.2.3',
		'--tag', 'pandalibrary:test', 'a path'
	]);
	assert.equal(containerBuildArgs('docker', 'test', stamp).includes('--format'), false);
});

test('requires unambiguous wrapper options', () => {
	assert.deepEqual(parseOptions([], 'container'), { output: 'pandalibrary:dev', release: '' });
	assert.deepEqual(parseOptions(['--output', 'a path', '--release', 'v1'], 'binary'), {
		output: 'a path', release: 'v1'
	});
	assert.throws(() => parseOptions([], 'binary'), /--output is required/);
	assert.throws(() => parseOptions(['--tag'], 'container'), /non-empty/);
	assert.throws(() => parseOptions(['--tag', 'a', '--tag', 'b'], 'container'), /once/);
	assert.throws(() => parseOptions(['--build-arg', 'COMMIT=fake'], 'container'), /Unknown option/);
});
