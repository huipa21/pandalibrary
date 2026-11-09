import { mount } from 'svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import ToolbarFixture from './toolbar-fixture.svelte';

declare global {
	interface Window {
		log: Array<{ action: string; value: string | number | boolean }>;
	}
}

const target = document.getElementById('pv4-test-root');
if (!target) throw new Error('The toolbar fixture root is missing.');
const params = new URLSearchParams(location.search);
setLocale(params.get('locale') === 'zh' ? 'zh' : 'en', { reload: false });
window.log = [];
mount(ToolbarFixture, { target });
