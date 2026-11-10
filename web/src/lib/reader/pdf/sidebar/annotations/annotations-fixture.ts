import { mount } from 'svelte';
import { activateOffline } from '#lib/sync/client.js';
import AnnotationsFixture from './annotations-fixture.svelte';

await activateOffline({ id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en' });
const target = document.getElementById('rp7-root');
if (!target) throw new Error('The annotations reveal fixture root is missing.');
mount(AnnotationsFixture, { target });
