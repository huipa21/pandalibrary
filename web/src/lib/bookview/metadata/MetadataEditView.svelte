<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { AGE_RATINGS, IDENTIFIER_SCHEMES, identifierValue, withIdentifier } from '#lib/metadata/editor.js';
	import type { MergeField } from '#lib/metadata/types.js';
	import Icon from '../Icon.svelte';
	import ChipInput from './ChipInput.svelte';
	import ProvenanceBadge from './ProvenanceBadge.svelte';
	import type { MetadataEditorState } from './editor-state.svelte.js';
	import { ageRatingLabel, CONTENT_RATINGS, contentRatingLabel, fieldLabels, ROLES, roleLabel } from './labels.js';

	let { editor, coverSource, onSearch }: {
		editor: MetadataEditorState;
		coverSource: string | null;
		onSearch: () => void;
	} = $props();

	const draft = $derived(editor.draft);
	const ageOptions = $derived.by(() => {
		const values: string[] = AGE_RATINGS.map(String);
		if (draft.age_rating !== '' && !values.includes(draft.age_rating)) values.push(draft.age_rating);
		return values;
	});

	function movePerson(index: number, offset: -1 | 1) {
		const next = index + offset;
		if (next < 0 || next >= draft.authors.length) return;
		const authors = [...draft.authors];
		[authors[index], authors[next]] = [authors[next]!, authors[index]!];
		editor.setDraft({ ...draft, authors }, 'authors');
	}

	function setIsbn(scheme: 'isbn10' | 'isbn13', value: string) {
		editor.setDraft(withIdentifier(draft, scheme, value), 'identifiers');
	}
</script>

{#snippet text(field: 'title' | 'subtitle' | 'language' | 'publisher' | 'published_date' | 'page_count', span: string)}
	<fieldset class={`field ${span}`} data-field={field}>
		<legend>{fieldLabels[field]()}</legend>
		<ProvenanceBadge {editor} {field} />
		<input aria-label={fieldLabels[field]()} id={`metadata-${field}`} inputmode={field === 'page_count' ? 'numeric' : 'text'}
			bind:value={editor.draft[field]} oninput={() => editor.edited(field)} />
	</fieldset>
{/snippet}

{#snippet badge(field: MergeField)}<ProvenanceBadge {editor} {field} />{/snippet}

<form aria-label={m['metadata.form.name']()} class="metadata-edit" onsubmit={(event) => {
	event.preventDefault();
	if (editor.editing && !editor.busy && !editor.lookupPending && editor.dirty) void editor.save();
}}>
	<aside class="cover-column">
		<fieldset class="field" data-field="cover" disabled={!editor.editing || editor.busy || editor.lookupPending}>
			<legend>{fieldLabels.cover()}</legend>
			{@render badge('cover')}
			{#if editor.selections.cover}
				<p class="text-sm">{m['metadata.cover.chosen']({ provider: editor.selections.cover.provider })}</p>
				{#if editor.chosenCoverPending}<p role="status">{m['metadata.cover.previewing']()}</p>
				{:else if editor.chosenCoverUrl}<img class="cover-image" src={editor.chosenCoverUrl} alt={m['metadata.cover.preview_alt']({ provider: editor.selections.cover.provider })} />
				{:else if editor.chosenCoverError}<p role="alert" class="text-red-800">{editor.chosenCoverError}</p>{/if}
			{:else if coverSource}
				<img class="cover-image" src={coverSource} alt={m['metadata.cover.current_alt']()} />
			{:else}
				<p class="cover-placeholder text-slate-500">{m['metadata.cover.none']()}</p>
			{/if}
		</fieldset>
		<div class="cover-actions">
			{#if editor.editing}
				<button type="submit" class="icon-button" aria-label={m['metadata.save.submit']()} title={m['metadata.save.submit']()}
					disabled={editor.busy || editor.lookupPending || !editor.dirty}>
					<Icon name="save" />
				</button>
			{:else}
				<button type="button" class="icon-button" aria-label={m['metadata.view.edit']()} title={m['metadata.view.edit']()}
					disabled={editor.busy || editor.lookupPending} onclick={() => editor.beginEdit()}>
					<Icon name="pencil" />
				</button>
			{/if}
			<button type="button" class="icon-button" aria-label={m['metadata.restore_all']()} title={m['metadata.restore_all']()}
				disabled={!editor.editing || editor.busy || editor.lookupPending || !editor.dirty} onclick={() => editor.restoreAll()}>
				<Icon name="undo" />
			</button>
			<button type="button" class="icon-button" aria-label={m['metadata.search.open']()} title={m['metadata.search.open']()}
				disabled={editor.busy || editor.lookupPending} onclick={onSearch}>
				<Icon name="search" />
			</button>
		</div>
		{#if editor.saveError}<p class="rounded-md bg-red-50 p-3 text-red-800" role="alert">{editor.saveError}</p>{/if}
		{#if editor.recoveryBlocked}
			<button type="button" class="secondary-button" disabled={editor.saving || editor.recovering || editor.lookupPending}
				onclick={() => editor.recoverFromConflict()}>{m['metadata.save.retry_recovery']()}</button>
		{/if}
	</aside>

	<fieldset class="form-body" disabled={!editor.editing || editor.busy || editor.lookupPending}>
		<div class="grid">
			{@render text('title', 'span-3')}
			{@render text('subtitle', 'span-2')}
			{@render text('language', 'span-1')}

			<fieldset class="field span-3" data-field="authors">
				<legend>{fieldLabels.authors()}</legend>
				{@render badge('authors')}
				<div class="people">
					{#each draft.authors as person, index (index)}
						<div class="person">
							<label class="sr-only" for={`person-name-${index}`}>{m['metadata.person.name']({ number: index + 1 })}</label>
							<input id={`person-name-${index}`} value={person.name}
								oninput={(event) => { editor.draft.authors[index] = { ...person, name: event.currentTarget.value }; editor.edited('authors'); }} />
							<label class="sr-only" for={`person-role-${index}`}>{m['metadata.person.role']({ number: index + 1 })}</label>
							<select id={`person-role-${index}`} value={person.role}
								onchange={(event) => { editor.draft.authors[index] = { ...person, role: event.currentTarget.value }; editor.edited('authors'); }}>
								{#each ROLES as role (role)}<option value={role}>{roleLabel(role)}</option>{/each}
								{#if !(ROLES as readonly string[]).includes(person.role)}<option value={person.role}>{person.role}</option>{/if}
							</select>
							<div class="row-actions">
								<button type="button" class="icon-button" aria-label={m['metadata.person.up']({ number: index + 1 })} title={m['metadata.person.up']({ number: index + 1 })}
									disabled={index === 0} onclick={() => movePerson(index, -1)}>↑</button>
								<button type="button" class="icon-button" aria-label={m['metadata.person.down']({ number: index + 1 })} title={m['metadata.person.down']({ number: index + 1 })}
									disabled={index === draft.authors.length - 1} onclick={() => movePerson(index, 1)}>↓</button>
								<button type="button" class="icon-button" aria-label={m['metadata.person.remove']({ number: index + 1 })} title={m['metadata.person.remove']({ number: index + 1 })}
									onclick={() => editor.setDraft({ ...draft, authors: draft.authors.filter((_, position) => position !== index) }, 'authors')}>×</button>
							</div>
						</div>
					{/each}
					<button type="button" class="secondary-button add-button"
						onclick={() => editor.setDraft({ ...draft, authors: [...draft.authors, { name: '', role: 'author' }] }, 'authors')}>{m['metadata.person.add']()}</button>
				</div>
			</fieldset>
			{@render text('publisher', 'span-2')}
			{@render text('published_date', 'span-1')}

			<fieldset class="field span-3" data-field="genres">
				<legend>{fieldLabels.genres()}</legend>
				{@render badge('genres')}
				<ChipInput {editor} field="genres" newLabel={m['metadata.genres.new']()} addLabel={m['metadata.genres.add']()}
					removeLabel={(name) => m['metadata.genres.remove_named']({ name })} emptyLabel={m['metadata.genres.empty']()} removeText={m['metadata.tags.remove']()} />
			</fieldset>
			<fieldset class="field span-3" data-field="moods">
				<legend>{fieldLabels.moods()}</legend>
				{@render badge('moods')}
				<ChipInput {editor} field="moods" newLabel={m['metadata.moods.new']()} addLabel={m['metadata.moods.add']()}
					removeLabel={(name) => m['metadata.moods.remove_named']({ name })} emptyLabel={m['metadata.moods.empty']()} removeText={m['metadata.tags.remove']()} />
			</fieldset>

			<fieldset class="field span-3" data-field="tags">
				<legend>{fieldLabels.tags()}</legend>
				{@render badge('tags')}
				<ChipInput {editor} field="tags" newLabel={m['metadata.tags.new']()} addLabel={m['metadata.tags.add']()}
					removeLabel={(name) => m['metadata.tags.remove_named']({ name })} emptyLabel={m['metadata.tags.empty']()} removeText={m['metadata.tags.remove']()} />
			</fieldset>
			<fieldset class="field span-3" data-field="series">
				<legend>{fieldLabels.series()}</legend>
				{@render badge('series')}
				<div class="series">
					<div>
						<label for="series-name">{m['metadata.series.name']()}</label>
						<input id="series-name" bind:value={editor.draft.series.name} oninput={() => editor.edited('series')} />
					</div>
					<div>
						<label for="series-index">{m['metadata.series.index']()}</label>
						<input id="series-index" inputmode="decimal" bind:value={editor.draft.series.index} oninput={() => editor.edited('series')} />
					</div>
					<div>
						<label for="series-total">{m['metadata.series.total']()}</label>
						<input id="series-total" inputmode="numeric" bind:value={editor.draft.series.total} oninput={() => editor.edited('series')} />
					</div>
				</div>
			</fieldset>

			<fieldset class="field span-1" data-field="isbn10">
				<legend>{m['metadata.field.isbn10']()}</legend>
				<input aria-label={m['metadata.field.isbn10']()} id="metadata-isbn10" value={identifierValue(draft, 'isbn10')}
					oninput={(event) => setIsbn('isbn10', event.currentTarget.value)} />
			</fieldset>
			<fieldset class="field span-1" data-field="isbn13">
				<legend>{m['metadata.field.isbn13']()}</legend>
				<input aria-label={m['metadata.field.isbn13']()} id="metadata-isbn13" value={identifierValue(draft, 'isbn13')}
					oninput={(event) => setIsbn('isbn13', event.currentTarget.value)} />
			</fieldset>
			<fieldset class="field span-1" data-field="age_rating">
				<legend>{fieldLabels.age_rating()}</legend>
				{@render badge('age_rating')}
				<select aria-label={fieldLabels.age_rating()} id="metadata-age_rating" bind:value={editor.draft.age_rating} onchange={() => editor.edited('age_rating')}>
					<option value="">{m['metadata.age.none']()}</option>
					{#each ageOptions as age (age)}<option value={age}>{ageRatingLabel(age)}</option>{/each}
				</select>
			</fieldset>
			<fieldset class="field span-2" data-field="content_rating">
				<legend>{fieldLabels.content_rating()}</legend>
				{@render badge('content_rating')}
				<select aria-label={fieldLabels.content_rating()} id="metadata-content_rating" bind:value={editor.draft.content_rating} onchange={() => editor.edited('content_rating')}>
					<option value="">{m['metadata.content.none']()}</option>
					{#each CONTENT_RATINGS as rating (rating)}<option value={rating}>{contentRatingLabel(rating)}</option>{/each}
				</select>
			</fieldset>
			{@render text('page_count', 'span-1')}

			<details class="provider-card span-6" open>
				<summary>{m['metadata.provider_section']()}</summary>
				<p class="text-sm text-slate-600">{m['metadata.provider_section.help']()}</p>
				<div class="provider-grid">
					<fieldset class="field" data-field="identifiers">
						<legend>{fieldLabels.identifiers()}</legend>
						{@render badge('identifiers')}
						<div class="people">
							{#each draft.identifiers as identifier, index (index)}
								<div class="identifier">
									<label class="sr-only" for={`identifier-scheme-${index}`}>{m['metadata.identifier.scheme']({ number: index + 1 })}</label>
									<select id={`identifier-scheme-${index}`} value={identifier.scheme}
										onchange={(event) => { editor.draft.identifiers[index] = { ...identifier, scheme: event.currentTarget.value }; editor.edited('identifiers'); }}>
										{#if identifier.scheme === ''}<option value=""></option>{/if}
										{#each IDENTIFIER_SCHEMES as scheme (scheme)}<option value={scheme}>{scheme}</option>{/each}
										{#if identifier.scheme !== '' && !(IDENTIFIER_SCHEMES as readonly string[]).includes(identifier.scheme)}<option value={identifier.scheme}>{identifier.scheme}</option>{/if}
									</select>
									<label class="sr-only" for={`identifier-value-${index}`}>{m['metadata.identifier.value']({ number: index + 1 })}</label>
									<input id={`identifier-value-${index}`} value={identifier.value}
										oninput={(event) => { editor.draft.identifiers[index] = { ...identifier, value: event.currentTarget.value }; editor.edited('identifiers'); }} />
									<button type="button" class="icon-button" aria-label={m['metadata.identifier.remove']({ number: index + 1 })} title={m['metadata.identifier.remove']({ number: index + 1 })}
										onclick={() => editor.setDraft({ ...draft, identifiers: draft.identifiers.filter((_, position) => position !== index) }, 'identifiers')}>×</button>
								</div>
							{/each}
							<button type="button" class="secondary-button add-button"
								onclick={() => editor.setDraft({ ...draft, identifiers: [...draft.identifiers, { scheme: '', value: '' }] }, 'identifiers')}>{m['metadata.identifier.add']()}</button>
						</div>
					</fieldset>
					<fieldset class="field" data-field="ratings">
						<legend>{fieldLabels.ratings()}</legend>
						{@render badge('ratings')}
						{#if draft.ratings.length}
							<ul class="ratings">
								{#each draft.ratings as row (row.provider)}
									<li data-provider={row.provider}>
										<span class="rating-provider">{row.provider}</span>
										<span>★ {row.rating ?? '–'}</span>
										<span># {row.count ?? '–'}</span>
									</li>
								{/each}
							</ul>
						{:else}
							<p class="text-sm text-slate-500">{m['metadata.ratings.empty']()}</p>
						{/if}
					</fieldset>
				</div>
			</details>

			<fieldset class="field span-6" data-field="description">
				<legend>{fieldLabels.description()}</legend>
				{@render badge('description')}
				<textarea aria-label={fieldLabels.description()} id="metadata-description" rows="8" bind:value={editor.draft.description}
					oninput={() => editor.edited('description')}></textarea>
			</fieldset>
		</div>
	</fieldset>

</form>

<style>
	.metadata-edit {
		display: grid; grid-template-columns: minmax(9rem, 13rem) minmax(0, 1fr); gap: 1.25rem; min-width: 0;
	}
	.cover-column { display: grid; align-content: start; gap: 0.75rem; min-width: 0; }
	.cover-column > button { justify-self: stretch; }
	.cover-actions { display: flex; gap: 0.5rem; }
	.cover-actions .icon-button { display: inline-flex; align-items: center; justify-content: center; width: 2.5rem; min-height: 2.5rem; }
	.form-body { min-width: 0; }
	.grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 0.75rem 1rem; }
	.span-1 { grid-column: span 1; }
	.span-2 { grid-column: span 2; }
	.span-3 { grid-column: span 3; }
	.span-6 { grid-column: 1 / -1; }
	.field { position: relative; min-width: 0; }
	.field > legend { margin-bottom: 0.25rem; padding-right: 4.5rem; font-size: 0.8125rem; font-weight: 600; color: #334155; }
	.field > :global(.provenance) { position: absolute; top: 0; right: 0; }
	label { display: block; margin-bottom: 0.125rem; font-size: 0.75rem; color: #475569; }
	input, textarea, select {
		width: 100%; min-width: 0; max-width: 100%; border: 1px solid #cbd5e1; border-radius: 0.375rem;
		padding: 0.375rem 0.625rem; background: white;
	}
	textarea { resize: vertical; }
	.secondary-button { border: 1px solid #cbd5e1; border-radius: 0.375rem; padding: 0.375rem 0.75rem; font-size: 0.875rem; font-weight: 500; }
	.icon-button { width: 2rem; min-height: 2rem; border: 1px solid #cbd5e1; border-radius: 0.375rem; font-size: 1rem; line-height: 1; }
	button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid #334155; outline-offset: 2px; }
	button:disabled { opacity: 0.5; cursor: not-allowed; }
	.people { display: grid; gap: 0.375rem; }
	.person { display: grid; grid-template-columns: minmax(0, 1fr) minmax(6rem, 9rem) auto; gap: 0.375rem; align-items: center; }
	.identifier { display: grid; grid-template-columns: minmax(6rem, 9rem) minmax(0, 1fr) auto; gap: 0.375rem; align-items: center; }
	.row-actions { display: flex; gap: 0.25rem; }
	.add-button { justify-self: start; }
	.series { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr); gap: 0.5rem; }
	.provider-card { border: 1px solid #e2e8f0; border-radius: 0.5rem; padding: 0.5rem 0.75rem; }
	.provider-card > summary { cursor: pointer; font-weight: 600; }
	.provider-card[open] > summary { margin-bottom: 0.5rem; }
	.provider-grid { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 1rem; margin-top: 0.75rem; }
	.ratings { display: grid; gap: 0.25rem; font-size: 0.875rem; }
	.ratings li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 0.75rem; }
	.rating-provider { overflow-wrap: anywhere; font-weight: 500; }
	.cover-image { width: 100%; max-height: 20rem; border-radius: 0.375rem; object-fit: contain; background: #f1f5f9; }
	.cover-placeholder { display: grid; place-items: center; aspect-ratio: 2 / 3; border-radius: 0.375rem; background: #f1f5f9; font-size: 0.875rem; text-align: center; padding: 0.5rem; }
	@media (max-width: 1023px) {
		.grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
		.span-1 { grid-column: span 1; }
		.span-2, .span-3 { grid-column: 1 / -1; }
		.provider-grid { grid-template-columns: minmax(0, 1fr); }
	}
	@media (max-width: 639px) {
		.metadata-edit { grid-template-columns: minmax(0, 1fr); }
		.cover-column { max-width: 13rem; }
		.grid { grid-template-columns: minmax(0, 1fr); }
		.span-1, .span-2, .span-3 { grid-column: 1 / -1; }
		.person, .identifier { grid-template-columns: minmax(0, 1fr) auto; }
		.person select { grid-column: 1; }
	}
</style>
