import DOMPurify from 'dompurify';
import type { FoliateBook } from 'foliate-js/view.js';

const SECTION_CSP = [
	"default-src 'none'",
	"script-src 'none'",
	"connect-src 'none'",
	"object-src 'none'",
	"frame-src 'none'",
	"child-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"img-src blob: data:",
	"style-src 'unsafe-inline' blob:",
	"font-src blob: data:",
	"media-src blob: data:"
].join('; ');

const blobCaptures = new Set<Map<string, Blob>>();
let originalCreateObjectURL: typeof URL.createObjectURL | null = null;

// Foliate exposes section URLs rather than Blobs, and the host CSP forbids fetching blob URLs.
function captureObjectURL(object: Blob | MediaSource): string {
	if (!originalCreateObjectURL) throw new Error('Book resource capture is unavailable.');
	const url = originalCreateObjectURL.call(URL, object);
	if (object instanceof Blob && /^(?:text\/html|application\/xhtml\+xml)$/.test(object.type)) {
		for (const capture of blobCaptures) capture.set(url, object);
	}
	return url;
}

export async function captureBookBlobs<T>(operation: () => T | Promise<T>): Promise<{ value: T; blobs: Map<string, Blob> }> {
	const blobs = new Map<string, Blob>();
	if (!blobCaptures.size) {
		originalCreateObjectURL = URL.createObjectURL;
		URL.createObjectURL = captureObjectURL;
	}
	blobCaptures.add(blobs);
	try {
		return { value: await operation(), blobs };
	} finally {
		blobCaptures.delete(blobs);
		if (!blobCaptures.size && originalCreateObjectURL) {
			URL.createObjectURL = originalCreateObjectURL;
			originalCreateObjectURL = null;
		}
	}
}

function isBookResource(value: string): boolean {
	if (/^data:image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(value)) {
		return true;
	}
	try {
		const url = new URL(value);
		return url.protocol === 'blob:' && url.origin === location.origin;
	} catch {
		return false;
	}
}

function isInternalLink(value: string): boolean {
	const compact = value.trim().replace(/[\u0000-\u0020\u007f]/g, '');
	return /^filepos:\d{1,15}$/i.test(compact) ||
		/^kindle:pos:fid:[0-9a-v]{1,16}:off:[0-9a-v]{1,16}$/i.test(compact) ||
		compact.startsWith('#') || (
		compact !== '' &&
		!compact.startsWith('/') &&
		!compact.includes('\\') &&
		!/^[a-z][a-z0-9+.-]*:/i.test(compact)
	);
}

function validViewport(value: string): boolean {
	const parts = value.split(',').map((part) => part.trim());
	return parts.length === 2 && parts.every((part) => /^(width|height)\s*=\s*[1-9]\d{0,4}$/i.test(part)) &&
		parts.some((part) => /^width/i.test(part)) && parts.some((part) => /^height/i.test(part));
}

export function sanitizeSection(markup: string): string {
	const clean = DOMPurify.sanitize(markup, {
		WHOLE_DOCUMENT: true,
		USE_PROFILES: { html: true, svg: true },
		ADD_TAGS: ['link', 'meta'],
		FORBID_TAGS: [
			'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input',
			'button', 'textarea', 'select', 'base', 'portal', 'template', 'foreignObject'
		],
		FORBID_ATTR: ['srcdoc', 'srcset', 'formaction', 'autofocus', 'target', 'download'],
		ALLOWED_URI_REGEXP: /^(?:(?:blob|https?|mailto|tel|cid):|filepos:\d{1,15}$|kindle:pos:fid:[0-9a-v]{1,16}:off:[0-9a-v]{1,16}$|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
	});
	const document = new DOMParser().parseFromString(clean, 'text/html');
	for (const element of document.querySelectorAll('*')) {
		const tag = element.localName.toLowerCase();
		if (tag === 'meta') {
			const name = element.getAttribute('name')?.toLowerCase();
			if (name !== 'viewport' || !validViewport(element.getAttribute('content') ?? '')) element.remove();
			continue;
		}
		if (tag === 'link') {
			const rel = element.getAttribute('rel')?.toLowerCase();
			if (rel !== 'stylesheet' || !isBookResource(element.getAttribute('href') ?? '')) element.remove();
			continue;
		}
		for (const attribute of Array.from(element.attributes)) {
			const name = attribute.name.toLowerCase();
			if (name.startsWith('on') || name === 'srcset' || name === 'srcdoc') {
				element.removeAttribute(attribute.name);
			} else if (name === 'src' || name === 'poster' || name === 'xlink:href') {
				if (!isBookResource(attribute.value)) element.removeAttribute(attribute.name);
			} else if (name === 'href') {
				const allowed = tag === 'a'
					? isInternalLink(attribute.value)
					: isBookResource(attribute.value) || attribute.value.startsWith('#');
				if (!allowed) element.removeAttribute(attribute.name);
			}
		}
	}
	const csp = document.createElement('meta');
	csp.httpEquiv = 'Content-Security-Policy';
	csp.content = SECTION_CSP;
	document.head.prepend(csp);
	return `<!doctype html>${document.documentElement.outerHTML}`;
}

export function isolateBookSections(
	book: FoliateBook,
	preloadedBlobs: Map<string, Blob>,
	onError: (error: unknown) => void
): void {
	const safeUrls = new Set<string>();
	const destroy = book.destroy?.bind(book);
	let destroyed = false;
	book.destroy = () => {
		destroyed = true;
		for (const url of safeUrls) URL.revokeObjectURL(url);
		safeUrls.clear();
		preloadedBlobs.clear();
		destroy?.();
	};
	for (const section of book.sections) {
		if (!section.load) {
			if (section.linear === 'no') continue;
			throw new Error('The book contains an unreadable section.');
		}
		const load = section.load.bind(section);
		const unload = section.unload?.bind(section);
		let safeUrl: string | null = null;
		let sourceUrl: string | null = null;
		let sourceBlob: Blob | null = null;
		let pending: Promise<string> | null = null;
		let generation = 0;
		section.load = async () => {
			if (safeUrl) return safeUrl;
			if (pending) return pending;
			const currentGeneration = generation;
			pending = (async () => {
				try {
					const { value: originalUrl, blobs } = await captureBookBlobs(load);
					if (!isBookResource(originalUrl) || !originalUrl.startsWith('blob:')) {
						throw new Error('The reader returned an unsafe section URL.');
					}
					const blob = blobs.get(originalUrl) ?? preloadedBlobs.get(originalUrl) ??
						(originalUrl === sourceUrl ? sourceBlob : null);
					if (!blob) throw new Error('The reader could not isolate a book section.');
					sourceUrl = originalUrl;
					sourceBlob = blob;
					preloadedBlobs.delete(originalUrl);
					const safeMarkup = sanitizeSection(await blob.text());
					if (destroyed || generation !== currentGeneration) throw new Error('The book section was closed while loading.');
					safeUrl = URL.createObjectURL(new Blob([safeMarkup], { type: 'text/html' }));
					safeUrls.add(safeUrl);
					return safeUrl;
				} catch (error) {
					onError(error);
					throw error;
				}
			})();
			try {
				return await pending;
			} finally {
				pending = null;
			}
		};
		section.unload = () => {
			generation += 1;
			if (safeUrl) {
				URL.revokeObjectURL(safeUrl);
				safeUrls.delete(safeUrl);
			}
			safeUrl = null;
			unload?.();
			if (unload) {
				sourceUrl = null;
				sourceBlob = null;
			}
		};
	}
}
