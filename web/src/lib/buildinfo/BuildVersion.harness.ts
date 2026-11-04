import { mount } from 'svelte';
import BuildVersion from './BuildVersion.svelte';

const target = document.querySelector('#version-root');
if (!(target instanceof HTMLElement)) throw new Error('Build version test root is missing');
mount(BuildVersion, { target });
