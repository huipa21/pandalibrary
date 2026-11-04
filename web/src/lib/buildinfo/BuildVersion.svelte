<script lang="ts">
	import { onMount } from 'svelte';
	import BuildVersionView from './BuildVersionView.svelte';
	import { fetchVersion, versionErrorState, type VersionState } from './version.js';

	let state = $state<VersionState>({ status: 'loading' });
	let controller: AbortController | undefined;

	onMount(() => {
		const online = () => {
			if (state.status === 'offline' || state.status === 'error') void load();
		};
		window.addEventListener('online', online);
		void load();
		return () => {
			controller?.abort();
			window.removeEventListener('online', online);
		};
	});

	async function load() {
		controller?.abort();
		const request = new AbortController();
		controller = request;
		state = { status: 'loading' };
		try {
			const info = await fetchVersion(request.signal);
			if (!request.signal.aborted) state = { status: 'ready', info };
		} catch (error) {
			if (request.signal.aborted) return;
			console.error('Could not load build version', error);
			state = { status: versionErrorState(error, navigator.onLine) };
		}
	}
</script>

<BuildVersionView {state} onretry={load} />
