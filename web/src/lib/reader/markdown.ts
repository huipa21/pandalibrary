import DOMPurify from 'dompurify';
import { marked } from 'marked';

export function renderMarkdown(markdown: string): string {
	return DOMPurify.sanitize(marked.parse(markdown, { async: false }), {
		USE_PROFILES: { html: true },
		FORBID_TAGS: ['style', 'img', 'iframe', 'object', 'embed', 'form', 'input', 'video', 'audio'],
		FORBID_ATTR: ['style', 'target']
	});
}
