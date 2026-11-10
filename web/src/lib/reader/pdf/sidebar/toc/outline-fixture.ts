import { pdfFixture } from '../../../fixtures';

export function outlinePdfFixture(): Buffer {
	const base = pdfFixture(3).toString('latin1');
	const previousXref = Number(base.match(/startxref\s+(\d+)/)?.[1]);
	const size = Number(base.match(/\/Size\s+(\d+)/)?.[1]);
	if (!Number.isInteger(previousXref) || !Number.isInteger(size)) {
		throw new Error('The base PDF fixture has no valid cross-reference table.');
	}

	const first = size + 1;
	const objects = [
		{ id: 1, body: `<< /Type /Catalog /Pages 2 0 R /Outlines ${first} 0 R /PageMode /UseOutlines /Dests << /Opening [3 0 R /Fit] >> >>` },
		{ id: first, body: `<< /Type /Outlines /First ${first + 1} 0 R /Last ${first + 6} 0 R /Count 6 >>` },
		{ id: first + 1, body: `<< /Title (Part One) /Parent ${first} 0 R /First ${first + 2} 0 R /Last ${first + 3} 0 R /Next ${first + 4} 0 R /Count 2 /Dest (Opening) >>` },
		{ id: first + 2, body: `<< /Title (Opening) /Parent ${first + 1} 0 R /Next ${first + 3} 0 R /Dest (Opening) >>` },
		{ id: first + 3, body: `<< /Title (Middle) /Parent ${first + 1} 0 R /Dest [5 0 R /XYZ null 396 null] >>` },
		{ id: first + 4, body: `<< /Title (Part Two) /Parent ${first} 0 R /Next ${first + 5} 0 R /Dest [7 0 R /Fit] >>` },
		{ id: first + 5, body: `<< /Title (Unresolved) /Parent ${first} 0 R /Next ${first + 6} 0 R /Dest [999 0 R /Fit] >>` },
		{ id: first + 6, body: `<< /Title (Project site) /Parent ${first} 0 R /A << /S /URI /URI (https://example.test/contents) >> >>` }
	];
	const output = base.endsWith('\n') ? base : `${base}\n`;
	let update = output;
	const offsets = new Map<number, number>();
	for (const { id, body } of objects) {
		offsets.set(id, Buffer.byteLength(update, 'latin1'));
		update += `${id} 0 obj\n${body}\nendobj\n`;
	}

	const xref = Buffer.byteLength(update, 'latin1');
	update += `xref\n1 1\n${formatOffset(offsets.get(1)!)} 00000 n \n`;
	update += `${first} ${objects.length - 1}\n`;
	for (let id = first; id < first + objects.length - 1; id++) {
		update += `${formatOffset(offsets.get(id)!)} 00000 n \n`;
	}
	update += `trailer\n<< /Size ${first + objects.length - 1} /Root 1 0 R /Prev ${previousXref} >>\n`;
	update += `startxref\n${xref}\n%%EOF\n`;
	return Buffer.from(update, 'latin1');
}

function formatOffset(offset: number | undefined): string {
	if (offset === undefined) throw new Error('The outline fixture is missing an object offset.');
	return `${String(offset).padStart(10, '0')}`;
}
