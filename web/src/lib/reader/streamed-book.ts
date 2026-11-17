import type { FoliateBook } from 'foliate-js/view.js';
import type { ReaderSource } from './source.js';

const MIME_TYPES = {
	epub: 'application/epub+zip',
	mobi: 'application/x-mobipocket-ebook',
	azw3: 'application/vnd.amazon.ebook',
	fb2: 'application/x-fictionbook+xml',
	fbz: 'application/x-zip-compressed-fb2',
	cbz: 'application/vnd.comicbook+zip'
} as const;

type Format = keyof typeof MIME_TYPES;

interface ZipEntry {
	filename: string;
	uncompressedSize: number;
	getData(writer: unknown): Promise<unknown>;
}

interface ZipLoader {
	entries: ZipEntry[];
	loadText(name: string): Promise<string | null>;
	loadBlob(name: string, type?: string): Promise<Blob | null>;
	getSize(name: string): number;
}

const isZip = async (source: ReaderSource): Promise<boolean> => {
	if (source.size < 4) return false;
	const header = await source.read(0, 4);
	return header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04;
};

const isCBZ = (source: ReaderSource): boolean =>
	source.type === MIME_TYPES.cbz || source.name.toLowerCase().endsWith('.cbz');

const isFB2 = (source: ReaderSource): boolean =>
	source.type === MIME_TYPES.fb2 || source.name.toLowerCase().endsWith('.fb2');

const isFBZ = (source: ReaderSource): boolean =>
	source.type === MIME_TYPES.fbz ||
	source.name.toLowerCase().endsWith('.fb2.zip') ||
	source.name.toLowerCase().endsWith('.fbz');

async function makeZipLoader(source: ReaderSource): Promise<ZipLoader & { close(): Promise<void> }> {
	const { configure, ZipReader, BlobReader, TextWriter, BlobWriter } = await import('foliate-js/vendor/zip.js');
	configure({ useWebWorkers: false });
	const reader = new ZipReader(new BlobReader(source));
	const entries = await reader.getEntries() as ZipEntry[];
	const map = new Map(entries.map((entry) => [entry.filename, entry]));
	const load = <T>(load: (entry: ZipEntry, ...args: unknown[]) => Promise<T>) =>
		(name: string, ...args: unknown[]): Promise<T | null> => {
			const entry = map.get(name);
			return entry ? load(entry, ...args) : Promise.resolve(null);
		};
	const loadText = load((entry) => entry.getData(new TextWriter()) as Promise<string>);
	const loadBlob = load((entry, type) => entry.getData(new BlobWriter(type as string | undefined)) as Promise<Blob>);
	return {
		entries,
		loadText,
		loadBlob,
		getSize: (name) => map.get(name)?.uncompressedSize ?? 0,
		close: () => reader.close()
	};
}


function prefetchNextSection(book: FoliateBook, loader: ZipLoader): void {
	for (let index = 0; index < book.sections.length - 1; index += 1) {
		const section = book.sections[index];
		const load = section.load?.bind(section);
		const next = book.sections[index + 1]?.id;
		if (!load || !next) continue;
		section.load = async () => {
			const result = await load();
			const warm = () => { void loader.loadBlob(next).catch(() => {}); };
			if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 1000 });
			else setTimeout(warm, 250);
			return result;
		};
	}
}

function closeWithBook(book: FoliateBook, close: () => Promise<void> | void, source: ReaderSource): FoliateBook {
	const destroy = book.destroy?.bind(book);
	let closed = false;
	book.destroy = () => {
		if (closed) return;
		closed = true;
		try {
			destroy?.();
		} finally {
			source.close();
			void close();
		}
	};
	return book;
}

/**
 * Builds the same foliate book objects as `makeBook`, but the file is read
 * through a range-backed source instead of a fully downloaded File.
 */
export async function makeStreamedBook(source: ReaderSource, format: Format): Promise<FoliateBook> {
	if (source.size <= 0) throw new Error('The book file is empty.');
	if (await isZip(source)) {
		const loader = await makeZipLoader(source);
		try {
			if (isCBZ(source)) {
				const { makeComicBook } = await import('foliate-js/comic-book.js');
				const book = await makeComicBook(loader, source);
				prefetchNextSection(book, loader);
				return closeWithBook(book, () => loader.close(), source);
			}
			if (isFBZ(source)) {
				const { makeFB2 } = await import('foliate-js/fb2.js');
				const entry = loader.entries.find((candidate) => candidate.filename.toLowerCase().endsWith('.fb2')) ?? loader.entries[0];
				if (!entry) throw new Error('The archive contains no FB2 book.');
				const blob = await loader.loadBlob(entry.filename);
				if (!blob) throw new Error('The FB2 entry could not be read.');
				const book = await makeFB2(blob);
				return closeWithBook(book, () => loader.close(), source);
			}
			const { EPUB } = await import('foliate-js/epub.js');
			const book = await new EPUB(loader).init();
			prefetchNextSection(book, loader);
			return closeWithBook(book, () => loader.close(), source);
		} catch (error) {
			await loader.close().catch(() => {});
			source.close();
			throw error;
		}
	}

	const { isMOBI, MOBI } = await import('foliate-js/mobi.js');
	if (await isMOBI(source)) {
		const { unzlibSync } = await import('foliate-js/vendor/fflate.js');
		const book = await new MOBI({ unzlib: unzlibSync }).open(source);
		return closeWithBook(book, () => {}, source);
	}
	if (isFB2(source)) {
		const { makeFB2 } = await import('foliate-js/fb2.js');
		const data = await source.arrayBuffer();
		const book = await makeFB2(new Blob([data], { type: MIME_TYPES.fb2 }));
		return closeWithBook(book, () => {}, source);
	}
	source.close();
	throw new Error('File type not supported');
}
