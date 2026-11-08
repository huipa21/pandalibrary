import { expect, type APIRequestContext } from '@playwright/test';
import { randomBytes } from 'node:crypto';

export function uuidv7(time = Date.now()): string {
	const bytes = randomBytes(16);
	bytes.writeUIntBE(time, 0, 6);
	bytes[6] = 0x70 | (bytes[6] & 0x0f);
	bytes[8] = 0x80 | (bytes[8] & 0x3f);
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function push(api: APIRequestContext, mutations: Array<Record<string, unknown>>) {
	const response = await api.post('/api/v1/sync/push', { data: { mutations } });
	expect(response.ok(), await response.text()).toBe(true);
	const { results } = await response.json() as { results: Array<{ status: string; reason?: string }> };
	expect(results.map((result) => result.reason ?? result.status)).toEqual(mutations.map(() => 'applied'));
}
