<script lang="ts">
	import type { Book } from '#lib/catalog/types.js';
	import { createBookContext, setBookContext } from '../book-context.svelte.js';
	import DetailsPanel from './DetailsPanel.svelte';

	const context = setBookContext(createBookContext());
	let permission = $state<'context' | 'allow' | 'deny'>('context');
	let offline = $state(false);
	let book = $state<Book>({
		owner_id: null, visibility: 'library', can_manage_visibility: false,
		id: 21, library_id: 1, title: 'Fixture', sort_title: 'Fixture', subtitle: null,
		description: null, language: null, publisher: null, published_date: null,
		page_count: null, cover_url: null, cover_source: null, authors: [], series: null,
		tags: [], identifiers: [], files: [], field_sources: [],
		created_at: '2026-11-06T10:00:00Z', updated_at: '2026-11-06T10:00:00Z'
	});
</script>

<label><input type="checkbox" bind:checked={context.canEditMetadata} /> Context permission</label>
<label>
	Edit permission override
	<select bind:value={permission}>
		<option value="context">Context</option>
		<option value="allow">Allow</option>
		<option value="deny">Deny</option>
	</select>
</label>
<label><input type="checkbox" bind:checked={offline} /> Offline</label>
<button type="button" onclick={() => (book = { ...book, id: 22 })}>Switch book</button>
<DetailsPanel {book} {offline} canEdit={permission === 'context' ? undefined : permission === 'allow'} />
