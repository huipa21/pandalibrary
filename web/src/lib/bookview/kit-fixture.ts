import { mount } from 'svelte';
import KitFixture from './kit-fixture.svelte';

const target = document.getElementById('bv3-test-root');
if (!target) throw new Error('The cover-kit test root is missing.');
mount(KitFixture, { target });
