import { paraglideVitePlugin } from '@inlang/paraglide-js';
import adapter from '@sveltejs/adapter-static';
import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { ocrAssets } from './scripts/ocr-assets.js';

export default defineConfig(({ command, mode }) => {
	const env = loadEnv(mode, '.', 'VITE_');
	const proxyTarget = env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8080';
	// Paraglide emits locale-modules in dev and message-modules (~3k files) in builds.
	// Separate outdirs stop each run from rewriting the other's output, which made dev startup crawl.
	const paraglideOutdir = command === 'serve' ? './src/lib/paraglide-dev' : './src/lib/paraglide';

	return {
		resolve: {
			alias: [
				{
					find: /^#lib\/paraglide\//,
					replacement: fileURLToPath(new URL(`${paraglideOutdir}/`, import.meta.url))
				}
			]
		},
		plugins: [
			ocrAssets(),
			tailwindcss(),
			sveltekit({
				adapter: adapter({ fallback: 'index.html' }),
				paths: { relative: false }
			}),
			paraglideVitePlugin({
				project: './project.inlang',
				outdir: paraglideOutdir,
				emitTsDeclarations: true
			})
		],
		server: {
			proxy: {
				'/api': { target: proxyTarget, changeOrigin: true },
				'/opds': { target: proxyTarget, changeOrigin: true },
				'/kosync': { target: proxyTarget, changeOrigin: true }
			}
		},
		test: {
			environment: 'node',
			expect: { requireAssertions: true },
			include: ['src/**/*.{test,spec}.{js,ts}']
		}
	};
});
