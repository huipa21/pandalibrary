<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { createShelf, MAX_SHELF_NAME_BYTES, MAX_SHELF_DESCRIPTION_BYTES } from './api.js';
	import type { Shelf, ShelfInput, ShelfMode, RuleSet } from './types.js';

	interface Props {
		open: boolean;
		onclose: () => void;
		oncreated: (shelf: Shelf) => void;
	}

	let { open, onclose, oncreated }: Props = $props();

	let mode = $state<ShelfMode>('manual');
	let kind = $state<'private' | 'shared'>('private');
	let name = $state('');
	let description = $state('');
	let rules = $state<RuleSet>({ match: 'all', conditions: [] });
	let isSubmitting = $state(false);
	let error = $state('');
	let originalFocusElement: HTMLElement | null = null;
	let dialogElement = $state<HTMLDialogElement | null>(null);

	// Form validation
	let errors = $state<Record<string, string>>({});

	onMount(() => {
		return () => {
			originalFocusElement?.focus();
		};
	});

	function resetForm() {
		mode = 'manual';
		kind = 'private';
		name = '';
		description = '';
		rules = { match: 'all', conditions: [] };
		error = '';
		errors = {};
		isSubmitting = false;
	}

	function validateForm(): boolean {
		const newErrors: Record<string, string> = {};

		if (!name.trim()) {
			newErrors.name = 'Shelf name is required.';
		}

		// Validate rules if automatic
		if (mode === 'automatic') {
			if (rules.conditions.length === 0) {
				newErrors.rules = 'At least one condition is required for automatic shelves.';
			}
		}

		errors = newErrors;
		return Object.keys(newErrors).length === 0;
	}

	async function handleSubmit() {
		if (!validateForm()) return;

		isSubmitting = true;
		error = '';

		try {
			const input: ShelfInput = {
				kind,
				name: name.trim(),
				description: description.trim() || null,
				mode,
				rules: mode === 'automatic' ? rules : undefined
			};

			const shelf = await createShelf(input);
			resetForm();
			onclose();
			oncreated(shelf);

			// Dispatch event for other components to listen
			window.dispatchEvent(new CustomEvent('pandalibrary-shelves-changed'));
		} catch (e) {
			console.error('Failed to create shelf:', e);
			error = m['ux3.shelves.error']();
		} finally {
			isSubmitting = false;
		}
	}

	function handleDialogClose() {
		onclose();
	}

	function handleKeyDown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			onclose();
		}
	}

	function addCondition() {
		rules.conditions.push({ field: '', op: '', value: '' });
		rules = { ...rules };
	}

	function removeCondition(index: number) {
		rules.conditions.splice(index, 1);
		rules = { ...rules };
	}

	function updateCondition(index: number, prop: string, value: string | number) {
		if (index >= 0 && index < rules.conditions.length) {
			const condition = rules.conditions[index];
			const updated = { ...condition };
			(updated as Record<string, string | number>)[prop] = value;
			rules.conditions[index] = updated;
			rules = { ...rules };
		}
	}

	function handleBackgroundClick(event: MouseEvent) {
		if (event.target === event.currentTarget) {
			onclose();
		}
	}
</script>

{#if open}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onclick={handleBackgroundClick}>
		<dialog
			bind:this={dialogElement}
			class="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-6 shadow-lg"
			open={open}
			onkeydown={handleKeyDown}
		>
			<h2 class="text-lg font-semibold">{m['ux3.shelves.create_dialog_title']()}</h2>
			<p class="mt-1 text-sm text-slate-600">{m['ux3.shelves.create_dialog_description']()}</p>

			{#if error}
				<div class="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</div>
			{/if}

			<form class="mt-6 space-y-4" onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
				<!-- Shelf Type Selection -->
				<fieldset class="space-y-2">
					<legend class="text-sm font-medium">{m['ux3.shelves.type_label']()}</legend>
					<div class="space-y-2">
						<label class="flex items-center gap-2">
							<input type="radio" value="manual" bind:group={mode} disabled={isSubmitting} class="cursor-pointer" />
							<span class="text-sm">{m['ux3.shelves.type_manual']()}</span>
						</label>
						<label class="flex items-center gap-2">
							<input type="radio" value="automatic" bind:group={mode} disabled={isSubmitting} class="cursor-pointer" />
							<span class="text-sm">{m['ux3.shelves.type_automatic']()}</span>
						</label>
					</div>
					<p class="text-xs text-slate-600">{m['ux3.shelves.type_help']()}</p>
				</fieldset>

				<!-- Name -->
				<div>
					<label for="shelf_name" class="block text-sm font-medium">{m['ux3.shelves.name_label']()}</label>
					<input
						id="shelf_name"
						name="shelf_name"
						type="text"
						bind:value={name}
						disabled={isSubmitting}
						maxlength={MAX_SHELF_NAME_BYTES}
						placeholder=""
						class="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:bg-slate-100"
					/>
					{#if errors.name}
						<p class="mt-1 text-xs text-red-800">{errors.name}</p>
					{/if}
				</div>

				<!-- Description -->
				<div>
					<label for="shelf_description" class="block text-sm font-medium">{m['ux3.shelves.description_label']()}</label>
					<textarea
						id="shelf_description"
						name="shelf_description"
						bind:value={description}
						disabled={isSubmitting}
						maxlength={MAX_SHELF_DESCRIPTION_BYTES}
						rows="3"
						class="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:bg-slate-100"
					></textarea>
				</div>

				<!-- Privacy -->
				<fieldset class="space-y-2">
					<legend class="text-sm font-medium">{m['ux3.shelves.kind_label']()}</legend>
					<div class="space-y-2">
						<label class="flex items-center gap-2">
							<input type="radio" value="private" bind:group={kind} disabled={isSubmitting} class="cursor-pointer" />
							<span class="text-sm">{m['ux3.shelves.kind_private']()}</span>
						</label>
						<label class="flex items-center gap-2">
							<input type="radio" value="shared" bind:group={kind} disabled={isSubmitting} class="cursor-pointer" />
							<span class="text-sm">{m['ux3.shelves.kind_shared']()}</span>
						</label>
					</div>
				</fieldset>

				<!-- Rules for Automatic Shelves -->
				{#if mode === 'automatic'}
					<fieldset class="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4">
						<legend class="text-sm font-medium">{m['ux3.shelves.rules_label']()}</legend>

						<!-- Match Type -->
						<div class="space-y-2">
							<div class="flex gap-2">
								<label class="flex items-center gap-2">
									<input
										type="radio"
										value="all"
										checked={rules.match === 'all'}
										onchange={() => (rules = { ...rules, match: 'all' })}
										disabled={isSubmitting}
										class="cursor-pointer"
									/>
									<span class="text-sm">{m['ux3.shelves.rules_match_all']()}</span>
								</label>
								<label class="flex items-center gap-2">
									<input
										type="radio"
										value="any"
										checked={rules.match === 'any'}
										onchange={() => (rules = { ...rules, match: 'any' })}
										disabled={isSubmitting}
										class="cursor-pointer"
									/>
									<span class="text-sm">{m['ux3.shelves.rules_match_any']()}</span>
								</label>
							</div>
						</div>

						{#if errors.rules}
							<p class="text-xs text-red-800">{errors.rules}</p>
						{/if}

						<!-- Conditions -->
						{#each rules.conditions as condition, i (i)}
							<div class="space-y-2 rounded-md border border-slate-300 bg-white p-3">
								<div class="grid gap-2 sm:grid-cols-3">
									<!-- Field -->
									<div>
										<label for={`condition_${i}_field`} class="block text-xs font-medium">{m['ux3.shelves.rules_condition_field']()}</label>
										<select
											id={`condition_${i}_field`}
											value={condition.field}
											onchange={(e) => updateCondition(i, 'field', e.currentTarget.value)}
											disabled={isSubmitting}
											class="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:bg-slate-100"
										>
											<option value="">{m['ux3.shelves.rules_condition_field']()}</option>
											<option value="title">{m['ux3.shelves.rules_field_title']()}</option>
											<option value="author_id">{m['ux3.shelves.rules_field_author']()}</option>
											<option value="series_id">{m['ux3.shelves.rules_field_series']()}</option>
											<option value="tag_id">{m['ux3.shelves.rules_field_tag']()}</option>
											<option value="language">{m['ux3.shelves.rules_field_language']()}</option>
											<option value="format">{m['ux3.shelves.rules_field_format']()}</option>
											<option value="reading_status">{m['ux3.shelves.rules_field_reading_status']()}</option>
										</select>
										{#if errors[`condition_${i}_field`]}
											<p class="mt-1 text-xs text-red-800">{errors[`condition_${i}_field`]}</p>
										{/if}
									</div>

									<!-- Operator -->
									<div>
										<label for={`condition_${i}_op`} class="block text-xs font-medium">{m['ux3.shelves.rules_condition_operator']()}</label>
										<select
											id={`condition_${i}_op`}
											value={condition.op}
											onchange={(e) => updateCondition(i, 'op', e.currentTarget.value)}
											disabled={isSubmitting}
											class="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:bg-slate-100"
										>
											<option value="">{m['ux3.shelves.rules_condition_operator']()}</option>
											<option value="contains">{m['ux3.shelves.rules_operator_contains']()}</option>
											<option value="eq">{m['ux3.shelves.rules_operator_eq']()}</option>
										</select>
										{#if errors[`condition_${i}_op`]}
											<p class="mt-1 text-xs text-red-800">{errors[`condition_${i}_op`]}</p>
										{/if}
									</div>

									<!-- Value -->
									<div>
										<label for={`condition_${i}_value`} class="block text-xs font-medium">{m['ux3.shelves.rules_condition_value']()}</label>
										<input
											id={`condition_${i}_value`}
											type="text"
											value={condition.value}
											onchange={(e) => updateCondition(i, 'value', e.currentTarget.value)}
											disabled={isSubmitting}
											class="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:bg-slate-100"
										/>
										{#if errors[`condition_${i}_value`]}
											<p class="mt-1 text-xs text-red-800">{errors[`condition_${i}_value`]}</p>
										{/if}
									</div>
								</div>

								<!-- Delete condition button -->
								<button
									type="button"
									onclick={() => removeCondition(i)}
									disabled={isSubmitting}
									class="text-xs text-red-600 underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500 disabled:opacity-50"
								>
									{m['ux3.shelves.rules_condition_delete']()}
								</button>
							</div>
						{/each}

						<!-- Add condition button -->
						<button
							type="button"
							onclick={addCondition}
							disabled={isSubmitting}
							class="text-xs text-blue-600 underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-50"
						>
							{m['ux3.shelves.rules_add']()}
						</button>

						{#if errors.rules}
							<p class="text-xs text-red-800">{errors.rules}</p>
						{/if}
					</fieldset>
				{/if}

				<!-- Buttons -->
				<div class="mt-6 flex gap-3">
					<button
						type="button"
						onclick={onclose}
						disabled={isSubmitting}
						class="flex-1 rounded border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 disabled:opacity-50"
					>
						{m['ux3.shelves.cancel']()}
					</button>
					<button
						type="submit"
						disabled={isSubmitting}
						class="flex-1 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-50"
					>
						{isSubmitting ? m['ux3.shelves.creating']() : m['ux3.shelves.create_submit']()}
					</button>
				</div>
			</form>
		</dialog>
	</div>
{/if}
