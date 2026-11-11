<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { locales, type Locale } from '#lib/paraglide/runtime.js';
	import HeaderMenu from './HeaderMenu.svelte';
	import { filterLanguages, suggestedLocales } from './languages.js';
	import SearchField from '#lib/search/SearchField.svelte';

	interface Props {
		onlocale: (locale: Locale) => void | Promise<void>;
		compact?: boolean;
	}

	let { onlocale, compact = false }: Props = $props();
	let query = $state('');
	let currentLocale = $state<Locale>('en');
	let browserLanguages = $state<string[]>([]);
	let searchInput = $state<HTMLInputElement | null>(null);

	const uiLocale = $derived(currentLocale);
	const filtered = $derived(filterLanguages(query, uiLocale));
	const suggested = $derived(
		suggestedLocales(currentLocale, browserLanguages)
			.map((locale) => filtered.find((language) => language.code === locale))
			.filter((language) => language !== undefined)
	);
	const allLanguages = $derived(filtered);
	const hasResults = $derived(suggested.length > 0 || allLanguages.length > 0);

	function onOpen() {
		query = '';
		currentLocale = locales.includes(document.documentElement.lang as Locale)
			? (document.documentElement.lang as Locale)
			: 'en';
		browserLanguages = [...navigator.languages];
		searchInput?.focus();
	}

	function selectLocale(locale: Locale, close: () => void) {
		if (locale === currentLocale) {
			close();
			return;
		}
		void onlocale(locale);
	}
</script>

<HeaderMenu menuId={compact ? 'language-menu-drawer' : 'language-menu-header'} popup="dialog" label={m['hm1.language.button']()} onopen={onOpen}>
	{#snippet trigger({ expanded, controls, popup, toggle, onkeydown })}
		<button
			type="button"
			class={compact ? 'shell-menu-row' : 'shell-icon-button size-9'}
			aria-label={m['hm1.language.button']()}
			title={m['hm1.language.button']()}
			aria-haspopup={popup}
			aria-expanded={expanded}
			aria-controls={controls}
			onclick={toggle}
			onkeydown={onkeydown}
		>
			<svg aria-hidden="true" viewBox="0 0 20 20" class="size-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
				<circle cx="10" cy="10" r="7.25" />
				<path d="M2.9 10h14.2M10 2.8c2 2 3 4.4 3 7.2s-1 5.2-3 7.2c-2-2-3-4.4-3-7.2s1-5.2 3-7.2Z" />
			</svg>
			{#if compact}<span>{m['hm1.language.button']()}</span>{/if}
		</button>
	{/snippet}
	{#snippet children(close)}
		<div class="language-menu">
			<form role="search" onsubmit={(event) => event.preventDefault()}>
				<SearchField
					bind:input={searchInput}
					label={m['hm1.language.search']()}
					placeholder={m['hm1.language.search']()}
					bind:value={query}
				/>
			</form>

			{#if hasResults}
				{#if suggested.length}
					<section class="language-section" aria-labelledby="language-suggested-heading">
						<h2 id="language-suggested-heading" class="shell-heading">{m['hm1.language.suggested']()}</h2>
						<div role="listbox" aria-label={m['hm1.language.suggested']()}>
							{#each suggested as language (language.code)}
								<button
									type="button"
									role="option"
									aria-selected={language.code === currentLocale}
									class="language-option"
									onclick={() => selectLocale(language.code, close)}
								>
									<span class="language-check" aria-hidden="true">
										{#if language.code === currentLocale}
											<svg viewBox="0 0 20 20" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 10 4 4 8-8" /></svg>
										{/if}
									</span>
									<span class="language-native" lang={language.code}>{language.nativeName}</span>
									<span class="language-localized">{m[language.messageKey]()}</span>
								</button>
							{/each}
						</div>
					</section>
				{/if}
				<section class="language-section" aria-labelledby="language-all-heading">
					<h2 id="language-all-heading" class="shell-heading">{m['hm1.language.all']()}</h2>
					<div role="listbox" aria-label={m['hm1.language.all']()}>
						{#each allLanguages as language (language.code)}
							<button
								type="button"
								role="option"
								aria-selected={language.code === currentLocale}
								class="language-option"
								onclick={() => selectLocale(language.code, close)}
							>
								<span class="language-check" aria-hidden="true">
									{#if language.code === currentLocale}
										<svg viewBox="0 0 20 20" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 10 4 4 8-8" /></svg>
									{/if}
								</span>
								<span class="language-native" lang={language.code}>{language.nativeName}</span>
								<span class="language-localized">{m[language.messageKey]()}</span>
							</button>
						{/each}
					</div>
				</section>
			{:else}
				<p class="language-empty" role="status">{m['hm1.language.none']()}</p>
			{/if}
		</div>
	{/snippet}
</HeaderMenu>
