import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { isMain, parseOptions, projectRoot, resolveProvenance, runChecked } from './provenance.mjs';

export function selectContainerEngine(override, probe = (engine) =>
	spawnSync(engine, ['info'], { stdio: 'ignore' }).status === 0) {
	if (override) return override;
	for (const engine of ['docker', 'podman']) {
		if (probe(engine)) return engine;
	}
	throw new Error('No usable container engine found. Start Docker or Podman, or set CONTAINER_ENGINE explicitly.');
}

export function containerBuildArgs(engine, image, stamp, root = projectRoot, options = {}) {
	const format = /^podman(?:\.exe)?$/i.test(basename(engine)) ? ['--format', 'docker'] : [];
	const passthrough = (name, value) => value ? ['--build-arg', `${name}=${value}`] : [];
	return [
		'build', ...format,
		'--build-arg', `COMMIT=${stamp.commit}`,
		'--build-arg', `COMMIT_DATE=${stamp.commitDate}`,
		'--build-arg', `DIRTY=${stamp.dirty}`,
		'--build-arg', `RELEASE=${stamp.release}`,
		...passthrough('NPM_REGISTRY', options.npmRegistry),
		...passthrough('GOPROXY', options.goProxy),
		...passthrough('GOSUMDB', options.goSumDB),
		'--tag', image, root
	];
}

function main() {
	const { output, release } = parseOptions(process.argv.slice(2), 'container');
	const stamp = resolveProvenance(projectRoot, release);
	const engine = selectContainerEngine(process.env.CONTAINER_ENGINE);
	console.error(`Using container engine: ${engine}`);
	runChecked(engine, containerBuildArgs(engine, output, stamp, projectRoot, {
		npmRegistry: process.env.NPM_CONFIG_REGISTRY,
		goProxy: process.env.GOPROXY,
		goSumDB: process.env.GOSUMDB
	}));
}

if (isMain(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
