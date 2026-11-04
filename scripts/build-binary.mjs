import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isMain, linkerFlags, parseOptions, projectRoot, resolveProvenance, runChecked, stampArgs } from './provenance.mjs';

function main() {
	const { output, release } = parseOptions(process.argv.slice(2), 'binary');
	const stamp = resolveProvenance(projectRoot, release);
	const hostEnv = { ...process.env, CGO_ENABLED: '0' };
	delete hostEnv.GOOS;
	delete hostEnv.GOARCH;
	runChecked('go', ['run', './internal/buildinfo/cmd/checkstamp', ...stampArgs(stamp)], { env: hostEnv });
	mkdirSync(dirname(resolve(projectRoot, output)), { recursive: true });
	runChecked('go', [
		'build', '-trimpath', '-buildvcs=false', '-ldflags', linkerFlags(stamp),
		'-o', output, './cmd/pandalibrary'
	], { env: { ...process.env, CGO_ENABLED: '0' } });
}

if (isMain(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
