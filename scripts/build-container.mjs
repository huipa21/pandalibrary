import { basename } from 'node:path';
import { isMain, parseOptions, projectRoot, resolveProvenance, runChecked } from './provenance.mjs';

export function containerBuildArgs(engine, image, stamp, root = projectRoot) {
	const format = /^podman(?:\.exe)?$/i.test(basename(engine)) ? ['--format', 'docker'] : [];
	return [
		'build', ...format,
		'--build-arg', `COMMIT=${stamp.commit}`,
		'--build-arg', `COMMIT_DATE=${stamp.commitDate}`,
		'--build-arg', `DIRTY=${stamp.dirty}`,
		'--build-arg', `RELEASE=${stamp.release}`,
		'--tag', image, root
	];
}

function main() {
	const { output, release } = parseOptions(process.argv.slice(2), 'container');
	const stamp = resolveProvenance(projectRoot, release);
	const engine = process.env.CONTAINER_ENGINE || 'docker';
	runChecked(engine, containerBuildArgs(engine, output, stamp));
}

if (isMain(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
