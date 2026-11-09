import { writable } from 'svelte/store';

export const readerChrome = writable<'default' | 'full'>('default');
