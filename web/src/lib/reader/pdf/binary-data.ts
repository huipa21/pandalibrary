const assets = import.meta.glob('/node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*', {
	eager: true,
	query: '?url&no-inline',
	import: 'default'
});

/** Serves pdf.js CMaps, standard fonts and wasm decoders from bundled assets, so PDFs open offline. */
export class PdfBinaryDataFactory {
	async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
		const directories: Record<string, string> = {
			cMapUrl: 'cmaps',
			standardFontDataUrl: 'standard_fonts',
			wasmUrl: 'wasm'
		};
		const directory = directories[kind];
		const url = assets[`/node_modules/pdfjs-dist/${directory}/${filename}`];
		if (typeof url !== 'string') throw new Error('A PDF decoding resource is unavailable.');
		const response = await fetch(url);
		if (!response.ok) throw new Error('Could not load a PDF decoding resource.');
		return new Uint8Array(await response.arrayBuffer());
	}
}
