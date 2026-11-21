import { expect, test, type Page } from '@playwright/test';

const fullText = '🍎'.repeat(120) + '\nEntire original text';
const firstMeaning = 'Primary English meaning '.repeat(30);
async function mockEntries(page: Page, meaningLanguage = '') {
	await page.route('**/api/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/setup')) return route.fulfill({ json: { required: false } });
		if (path.endsWith('/auth/me')) return route.fulfill({ json: { user: {
			id: 1, username: 'test', display_name: 'Test', role: 'user', locale: 'en'
		} } });
		if (path.endsWith('/sync/pull')) return route.fulfill({ json: {
			cursor: 0, user_books: [], reading_progress: [], highlights: [], notes: [], user_settings: []
		} });
		if (path.endsWith('/wordbooks')) return route.fulfill({ json: { wordbooks: [{
			id: 1, name: 'English', language: 'en', meaning_language: meaningLanguage, description: '', is_default: true,
			archived: false, entry_count: 2, book_count: 1, created_at: '', updated_at: ''
		}] } });
		if (path.endsWith('/wordbooks/1/entries')) return route.fulfill({ json: { entries: [1, 2].map((id) => ({
			id, wordbook_id: 1, kind: 'word', text: id === 1 ? fullText : 'short', definition: '', note: '',
			dictionary_entries: id === 1 ? [
				{ source: 'jmdict', sourceName: 'Japanese dictionary', headword: 'りんご',
					reading: 'りんご', partOfSpeech: 'Japanese POS', definitions: ['Unrelated Japanese meaning'], match: 'exact' },
				{ source: 'ecdict', sourceName: 'Chinese translations', headword: 'apple',
					partOfSpeech: 'noun', definitions: ['苹果'], match: 'exact' },
				{ source: 'wiktionary-en', sourceName: 'English dictionary', headword: 'apple',
					partOfSpeech: 'noun', definitions: [firstMeaning, 'Secondary English meaning'], match: 'exact' }
			] : [],
			source: { book_id: null, book_file_id: null, locator: null, fraction: 0, book_title: 'Full source title', chapter: 'Source chapter' },
			created_at: '2026-01-01', updated_at: '2026-01-01'
		})) } });
		return route.fulfill({ json: { items: [], next_cursor: null, total: 0 } });
	});
}

test('compact entries reserve exactly four rows and retain full appropriate details', async ({ page }) => {
	await mockEntries(page);
	await page.goto('/wordbooks?id=1');
	const cards = page.locator('[data-entry-preview]');
	await expect(cards).toHaveCount(2);
	const first = page.locator('[data-entry-id="1"] [data-entry-preview]');
	await expect(first.locator('[data-entry-text]')).toHaveText('🍎'.repeat(99) + '…');
	await expect(first.locator('[data-entry-metadata]')).toHaveText('noun');
	await expect(first.locator('[data-entry-meaning]')).toContainText(firstMeaning.slice(0, 20));
	expect(await first.locator('[data-entry-meaning]').evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
	await expect(first).not.toContainText('Unrelated Japanese meaning');
	await expect(first).not.toContainText('苹果');
	await expect(first).not.toContainText('Full source title');
	for (const card of await cards.all()) {
		const bounds = await card.evaluate((element) => {
			const text = element.querySelector('[data-entry-text]')!;
			const metadata = element.querySelector('[data-entry-metadata]')!;
			const meaning = element.querySelector('[data-entry-meaning]')!;
			const line = parseFloat(getComputedStyle(text).lineHeight);
			return {
				line, total: element.getBoundingClientRect().height,
				text: text.getBoundingClientRect().height, metadata: metadata.getBoundingClientRect().height,
				meaning: meaning.getBoundingClientRect().height,
				clamp: getComputedStyle(meaning).webkitLineClamp,
				nowrap: getComputedStyle(text).whiteSpace
			};
		});
		expect(bounds.text).toBe(bounds.line);
		expect(bounds.metadata).toBe(bounds.line);
		expect(bounds.meaning).toBe(bounds.line * 2);
		expect(bounds.total).toBe(bounds.line * 4);
		expect(bounds.clamp).toBe('2');
		expect(bounds.nowrap).toBe('nowrap');
	}
	await first.getByRole('button', { name: fullText, exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Word details' });
	await expect(dialog.locator('[data-entry-text]')).toHaveText(fullText);
	await expect(dialog).toContainText(firstMeaning);
	await expect(dialog).toContainText('Secondary English meaning');
	await expect(dialog).toContainText('English dictionary');
	await expect(dialog).toContainText('Source chapter');
	await expect(dialog).not.toContainText('Unrelated Japanese meaning');
	await expect(dialog).not.toContainText('苹果');
	await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
	await expect(dialog.getByRole('textbox', { name: 'Selected text', exact: true })).toHaveValue(fullText);
});

test('explicit meaning language selects translations instead of same-language meanings', async ({ page }) => {
	await mockEntries(page, 'zh');
	await page.goto('/wordbooks?id=1');
	const card = page.locator('[data-entry-id="1"] [data-entry-preview]');
	await expect(card.locator('[data-entry-meaning]')).toHaveText('苹果');
	await card.getByRole('button', { name: fullText, exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Word details' });
	await expect(dialog).toContainText('苹果');
	await expect(dialog).toContainText('Chinese translations');
	await expect(dialog).not.toContainText('Secondary English meaning');
	await expect(dialog).not.toContainText('Unrelated Japanese meaning');
});

test('unsupported pronunciation displays a notification without opening details', async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
	});
	await mockEntries(page);
	await page.goto('/wordbooks?id=1');
	const card = page.locator('[data-entry-id="1"] [data-entry-preview]');
	const speaker = card.getByRole('button', { name: 'Pronounce', exact: true });
	await expect(speaker).toBeVisible();
	expect(await speaker.evaluate((button) => button.parentElement?.closest('button') === null)).toBe(true);
	await speaker.click();
	await expect(card.getByRole('status')).toHaveText('Pronunciation is unavailable.');
	await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('pronunciation uses the book language and reports speech failures', async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
			cancel() {},
			speak(utterance: SpeechSynthesisUtterance) {
				document.documentElement.dataset.speechLanguage = utterance.lang;
				utterance.onerror?.(new Event('error') as SpeechSynthesisErrorEvent);
			}
		} });
	});
	await mockEntries(page);
	await page.goto('/wordbooks?id=1');
	const card = page.locator('[data-entry-id="1"] [data-entry-preview]');
	await card.getByRole('button', { name: 'Pronounce', exact: true }).click();
	await expect(page.locator('html')).toHaveAttribute('data-speech-language', 'en');
	await expect(card.getByRole('status')).toHaveText('Could not play pronunciation. Please try again.');
	await expect(page.getByRole('dialog')).toHaveCount(0);
});
