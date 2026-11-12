import { mount } from 'svelte';
import { activateOffline } from '#lib/sync/client.js';
import BookmarksFixture from './bookmarks-fixture.svelte';

await activateOffline({ id: 1, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en' });
mount(BookmarksFixture, { target: document.getElementById('rp8-root')! });
