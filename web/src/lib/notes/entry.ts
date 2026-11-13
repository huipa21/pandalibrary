import type { AnnotationEntry } from './types.js';

export const annotationKinds = ['review', 'comment', 'highlight', 'underline', 'strikeout', 'text', 'ink', 'image'] as const;
export type AnnotationKindFilter = '' | typeof annotationKinds[number];

export function annotationKindFilter(value: string | null): AnnotationKindFilter {
	return annotationKinds.find((kind) => kind === value) ?? '';
}

export function annotationHref(item: AnnotationEntry): string {
	if (item.book_file_id && item.kind !== 'review') {
		const target = item.highlight_id
			? new URLSearchParams({ highlight: item.highlight_id })
			: new URLSearchParams({ annotation: item.id });
		return `/read/${item.book_id}/${item.book_file_id}?${target}`;
	}
	return `/books/${item.book_id}${item.kind === 'review' ? '#book-reviews-heading' : ''}`;
}

export function annotationKind(item: AnnotationEntry): string {
	return item.kind === 'note' ? 'comment' : item.kind;
}

export function annotationTagClass(kind: string): string {
	switch (kind) {
		case 'review': return 'bg-violet-100 text-violet-900';
		case 'comment': return 'bg-emerald-100 text-emerald-900';
		case 'highlight': return 'bg-amber-100 text-amber-900';
		case 'underline': return 'bg-blue-100 text-blue-900';
		case 'strikeout': return 'bg-rose-100 text-rose-900';
		case 'text': return 'bg-sky-100 text-sky-900';
		case 'ink': return 'bg-orange-100 text-orange-900';
		case 'image': return 'bg-fuchsia-100 text-fuchsia-900';
		default: return 'bg-slate-200 text-slate-800';
	}
}
