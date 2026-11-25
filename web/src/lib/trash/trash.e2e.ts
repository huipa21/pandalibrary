import { expect, test, type Page } from '@playwright/test';
import { confirmInApp } from '#lib/shell/confirmation.e2e-helper.js';
import type { TrashItem, TrashReference } from './api.js';

const key = ({ type, id }: TrashReference) => JSON.stringify([type, id]);

const initial: TrashItem[] = [
	{ id: '1', type: 'book', title: 'Deleted book', subtitle: 'An author', deletedAt: '2026-11-15T00:00:00Z' },
	{ id: '1', type: 'wordbook', title: 'Deleted wordbook', deletedAt: '2026-11-14T00:00:00Z' },
	{ id: 'note:1', type: 'annotation', title: 'Deleted annotation', subtitle: 'A book', deletedAt: '2026-10-01T00:00:00Z' }
];

async function setup(page: Page) {
	const state = { items: [...initial], failAction: false, errorStatus: 503, errorDetail: 'Unavailable', actions: [] as { method: string; items: TrashReference[] }[] };
	await page.route('**/api/v1/**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname.replace('/api/v1', '');
		if (path === '/setup') return route.fulfill({ json: { required: false } });
		if (path === '/auth/me') return route.fulfill({ json: {
			user: { id: 1, username: 'reader', display_name: 'Reader', role: 'admin', locale: 'en' }
		} });
		if (path === '/sync/pull') return route.fulfill({ json: {
			cursor: 0, user_books: [], reading_progress: [], highlights: [], bookmarks: [], notes: [], user_settings: []
		} });
		if (path.startsWith('/trash')) {
			if (request.method() !== 'GET') {
				const { items } = request.postDataJSON() as { items: TrashReference[] };
				state.actions.push({ method: request.method(), items });
				if (state.failAction) return route.fulfill({
					status: state.errorStatus, contentType: 'application/problem+json', json: { detail: state.errorDetail }
				});
				const keys = new Set(items.map(key));
				state.items = state.items.filter((item) => !keys.has(key(item)));
				return route.fulfill({ status: 204 });
			}
			return route.fulfill({ json: { items: state.items.filter((item) =>
				(!url.searchParams.get('type') || item.type === url.searchParams.get('type')) &&
				item.title.toLowerCase().includes((url.searchParams.get('search') ?? '').toLowerCase())
			) } });
		}
		if (path === '/wordbooks') return route.fulfill({ json: { wordbooks: [] } });
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	return state;
}

test('Trash uses shared header controls, filters each type and clears hidden selections', async ({ page }) => {
	await setup(page);
	await page.goto('/trash');
	await expect(page.getByTestId('trash-row')).toHaveCount(3);
	const search = page.getByRole('searchbox', { name: 'Search Trash' });
	await expect(search).toHaveClass(/\bcontrol-field\b/);
	const filter = page.getByRole('combobox', { name: 'Item type' });
	await expect(filter).toHaveClass(/\bcontrol-field\b/);
	await page.getByRole('button', { name: 'Toggle multi-select' }).click();
	await page.getByRole('checkbox', { name: 'Select Deleted book', exact: true }).check();
	for (const type of ['wordbook', 'annotation', 'book']) {
		await filter.selectOption(type);
		await expect(page.getByTestId('trash-row')).toHaveCount(1);
		await expect(page.getByRole('button', { name: 'Restore selected', exact: true })).toHaveCount(0);
	}
	await filter.selectOption('');
	await search.fill('annotation');
	await page.getByRole('search', { name: 'Search Trash', exact: true }).getByRole('button', { name: 'Search', exact: true }).click();
	await expect(page.getByTestId('trash-row')).toHaveCount(1);
	await expect(page.getByTestId('trash-row')).toContainText('Deleted annotation');
	await page.getByRole('button', { name: 'Clear search', exact: true }).click();
	await expect(page.getByTestId('trash-row')).toHaveCount(3);
});

test('Trash restores mixed selections and permanently deletes a single remaining item', async ({ page }) => {
	const state = await setup(page);
	await page.goto('/trash');
	await page.getByRole('button', { name: 'Toggle multi-select' }).click();
	await page.getByRole('checkbox', { name: 'Select Deleted book', exact: true }).check();
	await page.getByRole('checkbox', { name: 'Select Deleted annotation', exact: true }).check();
	await confirmInApp(page, () =>
		page.getByRole('button', { name: 'Restore selected', exact: true }).click()
	);
	await expect(page.getByTestId('trash-row')).toHaveCount(1);
	expect(state.actions[0]).toEqual({ method: 'POST', items: [
		{ id: '1', type: 'book' }, { id: 'note:1', type: 'annotation' }
	] });
	await confirmInApp(page, () => page.getByTestId('trash-row').getByRole('button', { name: 'Delete permanently', exact: true }).click());
	await expect(page.getByText('Trash is empty.', { exact: true })).toBeVisible();
	expect(state.actions[1]).toEqual({ method: 'DELETE', items: [{ id: '1', type: 'wordbook' }] });
});

test('Trash restores individually and confirms permanent group deletion with visible retry errors', async ({ page }) => {
	const state = await setup(page);
	await page.goto('/trash');
	const first = page.getByTestId('trash-row').filter({ hasText: 'Deleted book' });
	await expect(first.getByRole('button', { name: 'Restore', exact: true }).locator('[data-icon="undo"]')).toBeVisible();
	await expect(first.getByRole('button', { name: 'Delete permanently', exact: true }).locator('[data-icon="trash"]')).toBeVisible();
	await confirmInApp(page, () =>
		first.getByRole('button', { name: 'Restore', exact: true }).click()
	);
	await expect(page.getByTestId('trash-row')).toHaveCount(2);
	expect(state.actions[0]).toEqual({ method: 'POST', items: [{ id: '1', type: 'book' }] });
	await page.getByRole('button', { name: 'Toggle multi-select' }).click();
	await page.getByRole('checkbox', { name: 'Select Deleted wordbook', exact: true }).check();
	await page.getByRole('checkbox', { name: 'Select Deleted annotation', exact: true }).check();
	const deleteSelected = page.getByRole('button', { name: 'Delete selected permanently', exact: true });
	await confirmInApp(page, () => deleteSelected.click(), false);
	expect(state.actions).toHaveLength(1);
	state.failAction = true;
	await confirmInApp(page, () => deleteSelected.click(), true, (message: string) => {
		expect(message).toContain('2 item(s)');
	});
	await expect(page.getByRole('alert')).toContainText('The action failed');
	await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
	state.failAction = false;
	await confirmInApp(page, () => page.getByRole('alert').getByRole('button', { name: 'Try again' }).click());
	await expect(page.getByText('Trash is empty.', { exact: true })).toBeVisible();
	expect(state.actions.at(-1)).toEqual({ method: 'DELETE', items: [
		{ id: '1', type: 'wordbook' }, { id: 'note:1', type: 'annotation' }
	] });
});

test('Trash header icon toggles row checkboxes and shows group icons only for an active selection', async ({ page }) => {
	await setup(page);
	await page.goto('/trash');
	await expect(page.getByTestId('trash-row')).toHaveCount(3);
	const header = page.locator('.trash-toolbar');
	const toggle = header.getByRole('button', { name: 'Toggle multi-select' });
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await expect(toggle.locator('svg')).toBeVisible();
	await expect(page.locator('.selection-toolbar')).toHaveCount(0);
	await expect(page.getByTestId('trash-row').getByRole('checkbox')).toHaveCount(0);
	await expect(header.getByRole('button', { name: 'Restore selected', exact: true })).toHaveCount(0);
	await expect.poll(() => header.locator('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))))
		.toEqual(['Search', 'Toggle multi-select']);
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('trash-row').getByRole('checkbox')).toHaveCount(3);
	await expect(header.getByRole('button', { name: 'Restore selected', exact: true })).toHaveCount(0);
	await page.getByRole('checkbox', { name: 'Select Deleted book', exact: true }).check();
	await expect(header.getByRole('button', { name: 'Restore selected', exact: true }).locator('[data-icon="undo"]')).toBeVisible();
	await expect(header.getByRole('button', { name: 'Delete selected permanently', exact: true }).locator('[data-icon="trash"]')).toBeVisible();
	await header.getByRole('button', { name: 'Clear selection', exact: true }).click();
	await expect(header.getByRole('button', { name: 'Restore selected', exact: true })).toHaveCount(0);
	await page.getByRole('checkbox', { name: 'Select Deleted book', exact: true }).check();
	await toggle.click();
	await expect(page.getByTestId('trash-row').getByRole('checkbox')).toHaveCount(0);
	await expect(header.getByRole('button', { name: 'Restore selected', exact: true })).toHaveCount(0);
	await toggle.click();
	await expect(page.getByRole('checkbox', { name: 'Select Deleted book', exact: true })).not.toBeChecked();
});

test('Trash explains review restore conflicts without losing the selected review', async ({ page }) => {
	const state = await setup(page);
	state.items = [{ ...initial[2], id: 'review:42', title: 'Old review' }];
	state.failAction = true;
	state.errorStatus = 409;
	state.errorDetail = 'a review already exists for this book and user';
	await page.goto('/trash');
	await page.getByRole('button', { name: 'Toggle multi-select' }).click();
	const checkbox = page.getByRole('checkbox', { name: 'Select Old review', exact: true });
	await checkbox.check();
	await confirmInApp(page, () =>
		page.getByRole('button', { name: 'Restore selected', exact: true }).click()
	);
	await expect(page.getByRole('alert')).toContainText('A newer review already exists for this book.');
	await expect(page.getByRole('alert')).toContainText('permanently delete the old review from Trash');
	await expect(checkbox).toBeChecked();
	await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
	await expect(page.getByTestId('trash-row')).toHaveCount(1);
	expect(state.actions[0]).toEqual({ method: 'POST', items: [{ id: 'review:42', type: 'annotation' }] });
	state.errorDetail = 'parent highlight is deleted';
	await confirmInApp(page, () =>
		page.getByRole('alert').getByRole('button', { name: 'Try again' }).click()
	);
	await expect(page.getByRole('alert')).toContainText('The action failed');
	await expect(page.getByRole('alert')).not.toContainText('A newer review');
	await expect(checkbox).toBeChecked();
});
