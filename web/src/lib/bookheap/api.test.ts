import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api/client.js';
import { BOOKHEAP_FILES_PATH, apiErrorFromResponse, uploadHeapFile, type UploadRequest } from './api.js';
import { BOOKHEAP_CHANGED_EVENT, notifyBookheapChanged } from './events.js';

class FakeRequest implements UploadRequest {
	method = '';
	url = '';
	body: FormData | null = null;
	aborted = false;
	withCredentials = false;
	status = 0;
	statusText = '';
	responseText = '';
	headers: Record<string, string> = {};
	upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onabort: (() => void) | null = null;
	ontimeout: (() => void) | null = null;

	open(method: string, url: string) {
		this.method = method;
		this.url = url;
	}
	send(body: FormData) {
		this.body = body;
	}
	abort() {
		this.aborted = true;
		this.onabort?.();
	}
	getResponseHeader(name: string) {
		return this.headers[name.toLowerCase()] ?? null;
	}
	respond(status: number, body: string, contentType = 'application/json') {
		this.status = status;
		this.statusText = 'status';
		this.responseText = body;
		this.headers['content-type'] = contentType;
		this.onload?.();
	}
}

function setup() {
	const request = new FakeRequest();
	return { request, createRequest: () => request };
}

describe('uploadHeapFile', () => {
	it('posts one multipart file part with credentials and reports progress', async () => {
		const { request, createRequest } = setup();
		const onprogress = vi.fn();
		const book = new File(['data'], 'Dune.epub');
		const pending = uploadHeapFile(book, { createRequest, onprogress });
		expect(request).toMatchObject({ method: 'POST', url: BOOKHEAP_FILES_PATH, withCredentials: true });
		expect([...request.body!.keys()]).toEqual(['file']);
		expect((request.body!.get('file') as File).name).toBe('Dune.epub');

		request.upload.onprogress?.({ loaded: 3, total: 9, lengthComputable: true } as ProgressEvent);
		request.upload.onprogress?.({ loaded: 4, total: 0, lengthComputable: false } as ProgressEvent);
		expect(onprogress.mock.calls).toEqual([[3, 9], [4, null]]);

		request.respond(201, JSON.stringify({ item: { id: 12, title: 'Dune' } }));
		await expect(pending).resolves.toMatchObject({ id: 12, title: 'Dune' });
	});

	it('maps problem responses to ApiError like the JSON client', async () => {
		const { request, createRequest } = setup();
		const pending = uploadHeapFile(new File(['x'], 'a.epub'), { createRequest });
		request.respond(409, JSON.stringify({ title: 'Duplicate', status: 409, duplicate_of_book_id: 5 }), 'application/problem+json; charset=utf-8');
		const error = await pending.catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 409, problem: { duplicate_of_book_id: 5 } });
	});

	it('rejects malformed success bodies, network failures and aborts', async () => {
		let { request, createRequest } = setup();
		let pending = uploadHeapFile(new File(['x'], 'a.epub'), { createRequest });
		request.respond(201, '{}');
		await expect(pending).rejects.toMatchObject({ name: 'ApiError', status: 201 });

		({ request, createRequest } = setup());
		pending = uploadHeapFile(new File(['x'], 'a.epub'), { createRequest });
		request.onerror?.();
		await expect(pending).rejects.toBeInstanceOf(TypeError);

		({ request, createRequest } = setup());
		const controller = new AbortController();
		pending = uploadHeapFile(new File(['x'], 'a.epub'), { createRequest, signal: controller.signal });
		controller.abort();
		expect(request.aborted).toBe(true);
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

		const create = vi.fn(createRequest);
		await expect(uploadHeapFile(new File(['x'], 'a.epub'), { createRequest: create, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
		expect(create).not.toHaveBeenCalled();
	});

	it('parses only valid problem bodies', () => {
		expect(apiErrorFromResponse(500, 'Internal', 'text/plain', 'oops')).toMatchObject({ status: 500, problem: undefined, responseBody: 'oops' });
		expect(apiErrorFromResponse(413, 'Too Large', 'application/problem+json', '{bad').message).toBe('HTTP 413: invalid application/problem+json response');
		expect(apiErrorFromResponse(413, 'Too Large', 'application/problem+json', '{"title":1}').problem).toBeUndefined();
		expect(apiErrorFromResponse(415, 'Unsupported', 'application/problem+json', '{"title":"Unsupported","detail":"bad format"}').message).toBe('bad format');
	});
});

describe('notifyBookheapChanged', () => {
	it('dispatches the shared change event', () => {
		const target = new EventTarget();
		const listener = vi.fn();
		target.addEventListener(BOOKHEAP_CHANGED_EVENT, listener);
		notifyBookheapChanged(target);
		expect(BOOKHEAP_CHANGED_EVENT).toBe('pandalibrary-bookheap-changed');
		expect(listener).toHaveBeenCalledTimes(1);
		expect(() => notifyBookheapChanged(undefined)).not.toThrow();
	});
});
