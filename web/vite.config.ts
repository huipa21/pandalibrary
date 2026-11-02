import { paraglideVitePlugin } from '@inlang/paraglide-js';
import adapter from '@sveltejs/adapter-static';
import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, '.', 'VITE_');
	const proxyTarget = env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8080';

	return {
		plugins: [
			tailwindcss(),
			sveltekit({
				adapter: adapter({ fallback: 'index.html' })
			}),
			paraglideVitePlugin({
				project: './project.inlang',
				outdir: './src/lib/paraglide',
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
