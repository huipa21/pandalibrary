import { mount } from 'svelte';
import DetailsPanelFixture from './details-panel-fixture.svelte';

const target = document.getElementById('bd6-test-root');
if (!target) throw new Error('The details panel test root is missing.');
mount(DetailsPanelFixture, { target });
