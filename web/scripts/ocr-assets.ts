import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

export function ocrAssets(): Plugin {
	const require = createRequire(import.meta.url);
	const tesseract = createRequire(require.resolve('tesseract.js'));
	const core = dirname(tesseract.resolve('tesseract.js-core/package.json'));
	const files = new Map<string, Buffer>();
	files.set('worker.min.js', readFileSync(join(dirname(require.resolve('tesseract.js/package.json')), 'dist', 'worker.min.js')));
	files.set('worker.min.js.LICENSE.txt', readFileSync(join(dirname(require.resolve('tesseract.js/package.json')), 'dist', 'worker.min.js.LICENSE.txt')));
	files.set('LICENSE-tesseract-core', readFileSync(join(core, 'LICENSE')));
	for (const name of readdirSync(core).filter((name) => /^tesseract-core.*\.wasm\.js$/.test(name))) {
		files.set(name, readFileSync(join(core, name)));
	}
	for (const lang of ['eng', 'chi_sim']) {
		const root = dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
		files.set(`${lang}.traineddata.gz`, readFileSync(join(root, lang === 'chi_sim' ? '4.0.0' : '4.0.0_best_int', `${lang}.traineddata.gz`)));
	}
	const hash = createHash('sha256');
	for (const [name, data] of files) hash.update(name).update(data);
	const base = `_app/immutable/ocr/${hash.digest('hex').slice(0, 16)}/`;
	return {
		name: 'pandalibrary-ocr-assets',
		resolveId: (id) => id === 'virtual:ocr-assets' ? '\0virtual:ocr-assets' : undefined,
		load: (id) => id === '\0virtual:ocr-assets' ? `export default ${JSON.stringify(`/${base}`)};` : undefined,
		generateBundle() {
			for (const [name, source] of files) this.emitFile({ type: 'asset', fileName: base + name, source });
		},
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const name = request.url?.split('?')[0]?.slice(base.length + 1);
				const data = request.url?.startsWith(`/${base}`) && name ? files.get(name) : undefined;
				if (!data) return next();
				response.setHeader('Content-Type', name?.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
				response.end(data);
			});
		}
	};
}
