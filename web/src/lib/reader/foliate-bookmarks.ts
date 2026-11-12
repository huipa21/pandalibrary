export function bookmarkExcerpt(text: string): string {
	const encoder = new TextEncoder();
	let excerpt = '';
	let bytes = 0;
	for (const character of text.replace(/\s+/gu, ' ').trim()) {
		bytes += encoder.encode(character).length;
		if (bytes > 512) break;
		excerpt += character;
	}
	return excerpt.trimEnd();
}

export function firstVisibleLine(visible: Range): string {
	const doc = visible.startContainer.ownerDocument;
	if (!doc) return '';
	const walker = doc.createTreeWalker(visible.commonAncestorContainer, 4);
	const nodes: Node[] = [];
	if (visible.commonAncestorContainer.nodeType === 3) nodes.push(visible.commonAncestorContainer);
	else for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (visible.intersectsNode(node)) nodes.push(node);
	}
	const character = doc.createRange();
	const vertical = doc.defaultView?.getComputedStyle(doc.documentElement).writingMode.startsWith('vertical');
	let line: number | undefined;
	let text = '';
	for (const node of nodes) {
		const start = node === visible.startContainer ? visible.startOffset : 0;
		const end = node === visible.endContainer ? visible.endOffset : node.nodeValue!.length;
		for (let offset = start; offset < end; offset++) {
			character.setStart(node, offset);
			character.setEnd(node, offset + 1);
			const rect = Array.from(character.getClientRects()).find((rect) => rect.width > 0 && rect.height > 0);
			if (!rect) continue;
			const position = vertical ? rect.right : rect.top;
			if (line !== undefined && Math.abs(position - line) > 2) return bookmarkExcerpt(text);
			if (node.nodeValue![offset].trim()) line ??= position;
			text += node.nodeValue![offset];
			if (text.length >= 512) return bookmarkExcerpt(text);
		}
	}
	return bookmarkExcerpt(text);
}
