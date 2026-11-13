<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { translate } from '#lib/paging/translate.js';
	import { isIDField, RULE_FIELDS, RULE_FORMATS, RULE_STATUSES } from './rules.js';
	import { readStatusLabel, type ReadStatus } from '#lib/bookview/user-book.js';
	import type { RuleGroup } from './types.js';

	let { groups = $bindable<RuleGroup[]>([]), idPrefix, disabled = false }: {
		groups?: RuleGroup[]; idPrefix: string; disabled?: boolean;
	} = $props();

	function addGroup() {
		groups = [...groups, {
			id: crypto.randomUUID(), name: '',
			rules: { match: 'all', conditions: [{ field: 'title', op: 'contains', value: '' }] }
		}];
	}
</script>

<section class="grid gap-4" aria-label={m['collections.rules.heading']()}>
	<div>
		<h3 class="font-semibold">{m['collections.rules.heading']()}</h3>
		<p class="text-sm text-slate-600">{m['collections.rules.help']()}</p>
	</div>
	{#each groups as group, groupIndex (group.id)}
		<fieldset class="grid min-w-0 gap-3 rounded-md border border-slate-300 p-3" {disabled}>
			<legend class="px-1 text-sm font-medium">{m['collections.rules.group']({ number: groupIndex + 1 })}</legend>
			<label class="grid gap-1 text-sm" for={`${idPrefix}-${groupIndex}-name`}>
				{m['collections.rules.name']()}
				<input id={`${idPrefix}-${groupIndex}-name`} class="rounded-md border border-slate-300 px-2 py-1" bind:value={group.name} required />
			</label>
			<label class="grid gap-1 text-sm" for={`${idPrefix}-${groupIndex}-match`}>
				{m['collections.rules.match']()}
				<select id={`${idPrefix}-${groupIndex}-match`} class="rounded-md border border-slate-300 px-2 py-1" bind:value={group.rules.match}>
					<option value="all">{m['ux3.shelves.rules_match_all']()}</option>
					<option value="any">{m['ux3.shelves.rules_match_any']()}</option>
				</select>
			</label>
			{#each group.rules.conditions as condition, index (index)}
				<div class="grid gap-2 rounded-md border border-slate-200 p-2">
					<label class="grid gap-1 text-sm" for={`${idPrefix}-${groupIndex}-${index}-field`}>
						{m['ux3.shelves.rules_condition_field']()}
						<select id={`${idPrefix}-${groupIndex}-${index}-field`} class="rounded border border-slate-300 px-2 py-1" value={condition.field}
							onchange={(event) => {
								condition.field = event.currentTarget.value;
								condition.op = condition.field === 'title' ? 'contains' : 'eq';
								condition.value = '';
							}}>
							{#each RULE_FIELDS as field}
								<option value={field}>{translate(`ux3.shelves.rules_field_${field.replace('_id', '')}`)}</option>
							{/each}
						</select>
					</label>
					<p class="text-xs text-slate-500">{condition.op === 'contains' ? m['ux3.shelves.rules_operator_contains']() : m['ux3.shelves.rules_operator_eq']()}</p>
					<label class="grid gap-1 text-sm" for={`${idPrefix}-${groupIndex}-${index}-value`}>
						{isIDField(condition.field) ? m['collections.rules.id_value']() : m['ux3.shelves.rules_condition_value']()}
						{#if condition.field === 'format' || condition.field === 'reading_status'}
							<select id={`${idPrefix}-${groupIndex}-${index}-value`} class="rounded border border-slate-300 px-2 py-1" bind:value={condition.value} required>
								<option value="">{m['collections.rules.choose_value']()}</option>
								{#each condition.field === 'format' ? RULE_FORMATS : RULE_STATUSES as value}
									<option {value}>{condition.field === 'reading_status' ? readStatusLabel(value as ReadStatus) : value.toUpperCase()}</option>
								{/each}
							</select>
						{:else}
							<input id={`${idPrefix}-${groupIndex}-${index}-value`} class="rounded border border-slate-300 px-2 py-1"
								type={isIDField(condition.field) ? 'number' : 'text'} min={isIDField(condition.field) ? 1 : undefined} step={isIDField(condition.field) ? 1 : undefined}
								value={condition.value} required oninput={(event) => condition.value = isIDField(condition.field) ? Number(event.currentTarget.value) : event.currentTarget.value} />
						{/if}
					</label>
					<button type="button" class="justify-self-start text-sm text-red-700 underline" onclick={() => group.rules.conditions = group.rules.conditions.filter((_, i) => i !== index)}>{m['ux3.shelves.rules_condition_delete']()}</button>
				</div>
			{/each}
			<button type="button" class="justify-self-start text-sm underline" disabled={group.rules.conditions.length >= 20} onclick={() => group.rules.conditions.push({ field: 'title', op: 'contains', value: '' })}>{m['ux3.shelves.rules_add']()}</button>
			<button type="button" class="justify-self-start text-sm text-red-700 underline" onclick={() => groups = groups.filter((candidate) => candidate.id !== group.id)}>{m['collections.rules.remove']()}</button>
		</fieldset>
	{/each}
	<button type="button" class="justify-self-start rounded-md border border-slate-300 px-3 py-2 text-sm" disabled={disabled || groups.length >= 20} onclick={addGroup}>{m['collections.rules.add']()}</button>
</section>
