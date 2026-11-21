const K = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
] as const;

function rotr(value: number, bits: number): number {
	return (value >>> bits) | (value << (32 - bits));
}

function toHex(bytes: Uint8Array): string {
	let result = '';
	for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
	return result;
}

function abortError(): DOMException {
	return new DOMException('The upload was aborted.', 'AbortError');
}

/** Incremental SHA-256 for files too large to hold in one ArrayBuffer. */
export class Sha256 {
	#state = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
	]);
	#buffer = new Uint8Array(64);
	#bufferLength = 0;
	#bytes = 0;

	update(input: Uint8Array): this {
		this.#bytes += input.length;
		let offset = 0;
		if (this.#bufferLength > 0) {
			const needed = 64 - this.#bufferLength;
			if (input.length < needed) {
				this.#buffer.set(input, this.#bufferLength);
				this.#bufferLength += input.length;
				return this;
			}
			this.#buffer.set(input.subarray(0, needed), this.#bufferLength);
			this.#compress(this.#buffer);
			this.#bufferLength = 0;
			offset = needed;
		}
		while (offset + 64 <= input.length) {
			this.#compress(input.subarray(offset, offset + 64));
			offset += 64;
		}
		if (offset < input.length) {
			this.#buffer.set(input.subarray(offset));
			this.#bufferLength = input.length - offset;
		}
		return this;
	}

	digest(): string {
		const finalLength = this.#bufferLength < 56 ? 64 : 128;
		const final = new Uint8Array(finalLength);
		final.set(this.#buffer.subarray(0, this.#bufferLength));
		final[this.#bufferLength] = 0x80;
		const bits = this.#bytes * 8;
		const view = new DataView(final.buffer);
		view.setUint32(finalLength - 8, Math.floor(bits / 0x100000000), false);
		view.setUint32(finalLength - 4, bits >>> 0, false);
		for (let offset = 0; offset < finalLength; offset += 64) {
			this.#compress(final.subarray(offset, offset + 64));
		}
		const output = new Uint8Array(32);
		const outputView = new DataView(output.buffer);
		for (let index = 0; index < this.#state.length; index += 1) {
			outputView.setUint32(index * 4, this.#state[index], false);
		}
		return toHex(output);
	}

	#compress(block: Uint8Array): void {
		const words = new Int32Array(64);
		for (let index = 0; index < 16; index += 1) {
			const offset = index * 4;
			words[index] = (block[offset] << 24) | (block[offset + 1] << 16) | (block[offset + 2] << 8) | block[offset + 3];
		}
		for (let index = 16; index < 64; index += 1) {
			const previous = words[index - 15];
			const older = words[index - 2];
			const s0 = rotr(previous, 7) ^ rotr(previous, 18) ^ (previous >>> 3);
			const s1 = rotr(older, 17) ^ rotr(older, 19) ^ (older >>> 10);
			words[index] = (words[index - 16] + s0 + words[index - 7] + s1) | 0;
		}

		let a = this.#state[0] | 0;
		let b = this.#state[1] | 0;
		let c = this.#state[2] | 0;
		let d = this.#state[3] | 0;
		let e = this.#state[4] | 0;
		let f = this.#state[5] | 0;
		let g = this.#state[6] | 0;
		let h = this.#state[7] | 0;

		for (let index = 0; index < 64; index += 1) {
			const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const choice = (e & f) ^ (~e & g);
			const temp1 = (h + s1 + choice + K[index] + words[index]) | 0;
			const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (s0 + majority) | 0;
			h = g;
			g = f;
			f = e;
			e = (d + temp1) | 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) | 0;
		}

		this.#state[0] = (this.#state[0] + a) | 0;
		this.#state[1] = (this.#state[1] + b) | 0;
		this.#state[2] = (this.#state[2] + c) | 0;
		this.#state[3] = (this.#state[3] + d) | 0;
		this.#state[4] = (this.#state[4] + e) | 0;
		this.#state[5] = (this.#state[5] + f) | 0;
		this.#state[6] = (this.#state[6] + g) | 0;
		this.#state[7] = (this.#state[7] + h) | 0;
	}
}

export interface HashFileOptions {
	readonly signal?: AbortSignal;
	readonly onprogress?: (loaded: number, total: number) => void;
	readonly chunkSize?: number;
	/** Files up to this size use WebCrypto and its single ArrayBuffer. */
	readonly subtleLimit?: number;
}

/** Hashes a file in chunks, or with WebCrypto when it is small enough. */
export async function hashFile(file: Blob, options: HashFileOptions = {}): Promise<string> {
	const { signal, onprogress, chunkSize = 4 << 20, subtleLimit = 64 << 20 } = options;
	if (signal?.aborted) throw abortError();
	if (subtleLimit > 0 && file.size <= subtleLimit && globalThis.crypto?.subtle) {
		const data = await file.arrayBuffer();
		if (signal?.aborted) throw abortError();
		const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
		if (signal?.aborted) throw abortError();
		onprogress?.(file.size, file.size);
		return toHex(new Uint8Array(digest));
	}
	const hash = new Sha256();
	for (let offset = 0; offset < file.size; offset += chunkSize) {
		if (signal?.aborted) throw abortError();
		const end = Math.min(file.size, offset + chunkSize);
		const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
		if (signal?.aborted) throw abortError();
		hash.update(chunk);
		onprogress?.(end, file.size);
	}
	return hash.digest();
}
