import { describe, expect, it } from 'vitest';
import { Sha256, hashFile } from './sha256.js';

const encoder = new TextEncoder();
const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const blockBoundary = '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1';

describe('Sha256', () => {
	it.each([
		['', empty],
		['abc', abc],
		['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', blockBoundary]
	])('hashes %j', (input, digest) => {
		expect(new Sha256().update(encoder.encode(input)).digest()).toBe(digest);
	});

	it('streams chunks across block boundaries', () => {
		const input = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
		const hash = new Sha256();
		for (const character of input) hash.update(encoder.encode(character));
		expect(hash.digest()).toBe(blockBoundary);
	});
});

describe('hashFile', () => {
	it('hashes a file through the streaming path', async () => {
		const file = new File(['abc'], 'a.txt');
		await expect(hashFile(file, { subtleLimit: 0 })).resolves.toBe(abc);
	});
});
