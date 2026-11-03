/// <reference lib="webworker" />

import { immutable, assets } from '$app/manifest';
import { version } from '$app/env';
import { activeViewer } from './lib/sync/db.js';
import { synchronize } from './lib/sync/engine.js';

declare const self: ServiceWorkerGlobalScope;

const PREFIX = 'pandalibrary-shell-';
const CACHE = `${PREFIX}${version}`;
const ASSETS = new Set([...immutable, ...assets].map(({ path }) =>
	new URL(path, self.registration.scope).pathname
));

self.addEventListener('install', (event) => {
	event.waitUntil((async () => {
		const cache = await caches.open(CACHE);
		await cache.addAll([...new Set([...ASSETS, '/'])]);
		await self.skipWaiting();
	})());
});

self.addEventListener('activate', (event) => {
	event.waitUntil((async () => {
		const old = (await caches.keys()).filter((name) => name.startsWith(PREFIX) && name !== CACHE);
		await Promise.all(old.map((name) => caches.delete(name)));
		await self.clients.claim();
	})());
});

self.addEventListener('fetch', (event) => {
	const request = event.request;
	const url = new URL(request.url);
	if (request.method !== 'GET' || url.origin !== self.location.origin ||
		url.pathname.startsWith('/api/') || url.pathname.startsWith('/opds/') ||
		url.pathname.startsWith('/kosync/')) return;

	if (request.mode === 'navigate') {
		event.respondWith(fetch(request).catch(async () => {
			const shell = await (await caches.open(CACHE)).match('/');
			if (!shell) throw new Error('The offline application shell is unavailable.');
			return shell;
		}));
	} else if (ASSETS.has(url.pathname)) {
		event.respondWith((async () => {
			// Public build assets are identical even when the host varies on Origin.
			const cached = await (await caches.open(CACHE)).match(request, { ignoreSearch: true, ignoreVary: true });
			return cached ?? fetch(request);
		})());
	}
});

self.addEventListener('sync', (event) => {
	if (!(event instanceof ExtendableEvent) || !('tag' in event) || event.tag !== 'pandalibrary-outbox') return;
	event.waitUntil((async () => {
		const viewer = await activeViewer();
		if (!viewer) return;
		try {
			await synchronize(viewer.id);
			for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
				client.postMessage('pandalibrary-sync-complete');
			}
		} catch (error) {
			for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
				client.postMessage('pandalibrary-sync-request');
			}
			throw error;
		}
	})());
});
