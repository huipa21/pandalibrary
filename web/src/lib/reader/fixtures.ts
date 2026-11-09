import { crc32, deflateSync, inflateSync } from 'node:zlib';

export function pngFixture(width: number, height: number, [red, green, blue]: [number, number, number]): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const checksum = Buffer.alloc(4);
		checksum.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, checksum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.writeUInt8(8, 8);
	header.writeUInt8(2, 9);
	const row = Buffer.alloc(1 + width * 3);
	for (let x = 0; x < width; x++) row.set([red, green, blue], 1 + x * 3);
	const pixels = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))
	]);
}

function zip(entries: Record<string, string | Buffer>): Buffer {
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [path, content] of Object.entries(entries)) {
		const name = Buffer.from(path);
		const data = typeof content === 'string' ? Buffer.from(content) : content;
		const checksum = crc32(data);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(0x800, 6);
		header.writeUInt32LE(checksum, 14);
		header.writeUInt32LE(data.length, 18);
		header.writeUInt32LE(data.length, 22);
		header.writeUInt16LE(name.length, 26);
		local.push(header, name, data);
		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50, 0);
		directory.writeUInt16LE(20, 4);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt16LE(0x800, 8);
		directory.writeUInt32LE(checksum, 16);
		directory.writeUInt32LE(data.length, 20);
		directory.writeUInt32LE(data.length, 24);
		directory.writeUInt16LE(name.length, 28);
		directory.writeUInt32LE(offset, 42);
		central.push(directory, name);
		offset += header.length + name.length + data.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(entries).length, 8);
	end.writeUInt16LE(Object.keys(entries).length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}

export function epubFixture(
	title = 'Fixture Book',
	options: { author?: string; cover?: Buffer } = {}
): Buffer {
	const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=';
	return zip({
		mimetype: 'application/epub+zip',
		'META-INF/container.xml': `<?xml version="1.0"?>
			<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
				<rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles>
			</container>`,
		'OEBPS/book.opf': `<?xml version="1.0"?>
			<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
				<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
					<dc:identifier id="id">9780306406157</dc:identifier><dc:title>${title}</dc:title><dc:language>en</dc:language>
					${options.author ? `<dc:creator>${options.author}</dc:creator>` : ''}
				</metadata>
				<manifest>
					<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
					<item id="first" href="first.xhtml" media-type="application/xhtml+xml" properties="scripted"/>
					<item id="second" href="second.xhtml" media-type="application/xhtml+xml"/>
					${options.cover ? '<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>' : ''}
				</manifest>
				<spine><itemref idref="first"/><itemref idref="second"/></spine>
			</package>`,
		'OEBPS/nav.xhtml': `<?xml version="1.0"?>
			<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
				<head><title>Contents</title></head><body><nav epub:type="toc"><ol>
					<li><a href="first.xhtml">First</a></li><li><a href="second.xhtml">Second</a></li>
				</ol></nav></body>
			</html>`,
		'OEBPS/first.xhtml': `<?xml version="1.0"?>
			<html xmlns="http://www.w3.org/1999/xhtml">
				<head><title>First</title><meta http-equiv="refresh" content="0;url=/evil-redirect"/>
					<script>window.top.__epubInline = true</script><script src="/evil.js"></script>
				</head>
				<body>
					<h1>First section</h1>
					<p id="passage" onclick="window.top.__epubClick = true" onmouseover="window.top.__epubHover = true">A passage worth highlighting.</p>
					<img src="data:image/png;base64,${image}" onload="window.top.__epubLoad = true" alt="fixture"/>
					<iframe src="/evil-frame"></iframe>
					<a href="javascript:window.top.__epubLink=true">Unsafe link</a>
				</body>
			</html>`,
		'OEBPS/second.xhtml': `<?xml version="1.0"?>
			<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Second</title></head>
				<body><h1>Second section</h1><p>Another page of the fixture.</p></body>
			</html>`,
		...(options.cover ? { 'OEBPS/cover.png': options.cover } : {})
	});
}

export function fb2Fixture(): Buffer {
	return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
		<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
			<description><title-info><book-title>Fixture</book-title><lang>en</lang></title-info></description>
			<body><section><title><p>First section</p></title><p>A passage worth highlighting.</p></section></body>
			<body name="notes"><section id="footnote"><title><p>Footnotes</p></title><p>Non-linear note content.</p></section></body>
		</FictionBook>`);
}

export function fbzFixture(): Buffer {
	return zip({ 'fixture.fb2': fb2Fixture() });
}

export function cbzFixture(): Buffer {
	const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=', 'base64');
	return zip({ '001.png': image, '002.png': image });
}

export function mobiFixture(): Buffer {
	const text = Buffer.from('<html><head><title>Fixture</title></head><body><h1>First section</h1><p>A passage worth highlighting.</p><a filepos="0">Start</a></body></html>');
	const header = Buffer.alloc(264);
	header.writeUInt16BE(1, 0);
	header.writeUInt16BE(1, 8);
	header.writeUInt16BE(4096, 10);
	header.write('MOBI', 16);
	header.writeUInt32BE(248, 20);
	header.writeUInt32BE(65001, 28);
	header.writeUInt32BE(6, 36);
	header.writeUInt32BE(0xffffffff, 108);
	header.writeUInt32BE(0xffffffff, 244);
	const pdb = Buffer.alloc(96);
	pdb.write('BOOKMOBI', 60);
	pdb.writeUInt16BE(2, 76);
	pdb.writeUInt32BE(pdb.length, 78);
	pdb.writeUInt32BE(pdb.length + header.length, 86);
	return Buffer.concat([pdb, header, text]);
}

function varInt(value: number): Buffer {
	const bytes = [value & 0x7f];
	for (let remaining = value >>> 7; remaining; remaining >>>= 7) bytes.unshift(remaining & 0x7f);
	bytes[bytes.length - 1] |= 0x80;
	return Buffer.from(bytes);
}

function kf8Index(tags: number[][], name: string, values: number[]): [Buffer, Buffer] {
	const definition = Buffer.alloc(56 + 12 + tags.length * 4);
	definition.write('INDX', 0);
	definition.writeUInt32BE(56, 4);
	definition.writeUInt32BE(1, 24);
	definition.writeUInt32BE(65001, 28);
	definition.write('TAGX', 56);
	definition.writeUInt32BE(12 + tags.length * 4, 60);
	definition.writeUInt32BE(1, 64);
	for (const [index, tag] of tags.entries()) Buffer.from(tag).copy(definition, 68 + index * 4);
	const entryName = Buffer.from(name);
	const control = tags.reduce((bits, tag) => bits | tag[2], 0);
	const entry = Buffer.concat([Buffer.from([entryName.length]), entryName, Buffer.from([control]), ...values.map(varInt)]);
	const table = Buffer.alloc(62);
	table.write('INDX', 0);
	table.writeUInt32BE(56, 4);
	table.writeUInt32BE(56, 20);
	table.writeUInt32BE(1, 24);
	table.write('IDXT', 56);
	table.writeUInt16BE(62, 60);
	return [definition, Buffer.concat([table, entry])];
}

export function azw3Fixture(): Buffer {
	const skeleton = Buffer.from('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Fixture</title></head><body></body></html>');
	const fragment = Buffer.from('<h1>First section</h1><p>A passage worth highlighting.</p><a href="kindle:pos:fid:0000:off:0000000000">Start</a>');
	const insertion = skeleton.indexOf('</body>');
	const [skelIndex, skelTable] = kf8Index([[1, 1, 1, 0], [6, 2, 2, 0]], '0', [1, 0, skeleton.length]);
	const [fragIndex, fragTable] = kf8Index([[2, 1, 1, 0], [4, 1, 2, 0], [6, 2, 4, 0]], String(insertion), [0, 0, 0, fragment.length]);
	const header = Buffer.alloc(276);
	header.writeUInt16BE(1, 0);
	header.writeUInt16BE(1, 8);
	header.writeUInt16BE(4096, 10);
	header.write('MOBI', 16);
	header.writeUInt32BE(248, 20);
	header.writeUInt32BE(65001, 28);
	header.writeUInt32BE(8, 36);
	header.writeUInt32BE(6, 108);
	header.writeUInt32BE(0x40, 128);
	header.writeUInt32BE(0xffffffff, 192);
	header.writeUInt32BE(0xffffffff, 244);
	header.writeUInt32BE(4, 248);
	header.writeUInt32BE(2, 252);
	header.writeUInt32BE(0xffffffff, 260);
	header.write('EXTH', 264);
	header.writeUInt32BE(12, 268);
	const records = [header, Buffer.concat([skeleton, fragment]), skelIndex, skelTable, fragIndex, fragTable];
	const pdb = Buffer.alloc(78 + records.length * 8 + 2);
	pdb.write('BOOKMOBI', 60);
	pdb.writeUInt16BE(records.length, 76);
	let offset = pdb.length;
	for (const [index, record] of records.entries()) {
		pdb.writeUInt32BE(offset, 78 + index * 8);
		offset += record.length;
	}
	return Buffer.concat([pdb, ...records]);
}

export function pdfFixture(pageCount = 2): Buffer {
	const fontId = 3 + pageCount * 2;
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		`<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`
	];
	for (let index = 0; index < pageCount; index++) {
		const label = index === 0 ? 'First' : index === 1 ? 'Second' : `Page ${index + 1}`;
		const text = `BT /F1 24 Tf 72 700 Td (${label} PDF page text) Tj ET`;
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + index * 2} 0 R >>`,
			`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`
		);
	}

	objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
	let output = '%PDF-1.7\n';
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(output));
		output += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = Buffer.byteLength(output);
	output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
	output += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(output);
}

interface ScannedFixturePage {
	png: Buffer;
	width: number;
	height: number;
}

function pngRgb(png: Buffer): { pixels: Buffer; width: number; height: number } {
	const width = png.readUInt32BE(16);
	const height = png.readUInt32BE(20);
	const color = png[25];
	if (png[24] !== 8 || ![2, 6].includes(color) || png[28] !== 0) {
		throw new Error('The PDF fixture requires a non-interlaced 8-bit RGB/RGBA PNG.');
	}
	const channels = color === 6 ? 4 : 3;
	const chunks: Buffer[] = [];
	for (let offset = 8; offset < png.length;) {
		const length = png.readUInt32BE(offset);
		if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
		offset += length + 12;
	}
	const filtered = inflateSync(Buffer.concat(chunks));
	const raw = Buffer.alloc(width * height * channels);
	const stride = width * channels;
	for (let y = 0; y < height; y++) {
		const filter = filtered[y * (stride + 1)];
		for (let x = 0; x < stride; x++) {
			const index = y * stride + x;
			const a = x >= channels ? raw[index - channels] : 0;
			const b = y ? raw[index - stride] : 0;
			const c = y && x >= channels ? raw[index - stride - channels] : 0;
			const p = a + b - c;
			const distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
			const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? a
				: distances[1] <= distances[2] ? b : c;
			const predictors = [0, a, b, Math.floor((a + b) / 2), paeth];
			if (filter > 4) throw new Error('Unsupported PNG row filter.');
			raw[index] = (filtered[y * (stride + 1) + x + 1] + predictors[filter]) & 255;
		}
	}
	const pixels = Buffer.alloc(width * height * 3);
	for (let i = 0; i < width * height; i++) {
		const alpha = channels === 4 ? raw[i * channels + 3] / 255 : 1;
		for (let c = 0; c < 3; c++) pixels[i * 3 + c] = Math.round(raw[i * channels + c] * alpha + 255 * (1 - alpha));
	}
	return { pixels, width, height };
}

function imagePdf(pages: ScannedFixturePage[], textPage: boolean): Buffer {
	const objects: Buffer[] = [];
	const add = (value: string | Buffer) => objects.push(typeof value === 'string' ? Buffer.from(value) : value);
	const count = pages.length + Number(textPage);
	const kids = pages.map((_, index) => `${3 + index * 3} 0 R`);
	if (textPage) kids.unshift(`${3 + pages.length * 3} 0 R`);
	add('<< /Type /Catalog /Pages 2 0 R >>');
	add(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${count} >>`);
	for (const [index, page] of pages.entries()) {
		const image = pngRgb(page.png);
		const id = 3 + index * 3;
		const command = `q ${page.width} 0 0 ${page.height} 0 0 cm /Image Do Q`;
		const compressed = deflateSync(image.pixels);
		add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /XObject << /Image ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
		add(`<< /Length ${Buffer.byteLength(command)} >>\nstream\n${command}\nendstream`);
		add(Buffer.concat([
			Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`),
			compressed, Buffer.from('\nendstream')
		]));
	}
	if (textPage) {
		const id = 3 + pages.length * 3;
		const command = 'BT /F1 24 Tf 30 180 Td (True text page already has selectable content.) Tj ET';
		add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
		add(`<< /Length ${Buffer.byteLength(command)} >>\nstream\n${command}\nendstream`);
		add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
	}
	const parts = [Buffer.from('%PDF-1.7\n')];
	const offsets = [0];
	let length = parts[0].length;
	for (const [index, object] of objects.entries()) {
		offsets.push(length);
		const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
		parts.push(part);
		length += part.length;
	}
	parts.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
		offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
		`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
	return Buffer.concat(parts);
}

export function scannedPdfFixture(pages: ScannedFixturePage[]): Buffer {
	return imagePdf(pages, false);
}

export function mixedPdfFixture(page: ScannedFixturePage = { png: pngFixture(100, 100, [255, 255, 255]), width: 612, height: 792 }): Buffer {
	return imagePdf([page], true);
}
