import { describe, expect, it } from 'vitest';
import type { Highlight, Note } from '#lib/reader/types.js';
import {
	buildMarks,
	colorCounts,
	colorTone,
	filterMarks,
	groupByChapter,
	isoWeekStart,
	markStats,
	matchSegments,
	parseMarkSort,
	sortColorOptions,
	sortMarks,
	UNKNOWN_FORMAT,
	weekStartDate,
	type Mark
} from './highlights-model.js';

function highlight(id: string, overrides: Partial<Highlight> = {}): Highlight {
	return {
		id,
		book_id: 7,
		book_file_id: 70,
		locator: { type: 'cfi', value: 'epubcfi(/6/2!/4/2/1:0)' },
		position: 0.5,
		text: `Text ${id}`,
		color: 'yellow',
		chapter: 'One',
		created_at: '2026-11-01T10:00:00Z',
		updated_at: '2026-11-01T10:00:00Z',
		deleted_at: null,
		rev: 1,
		...overrides
	};
}

function note(id: string, highlightId: string | null, body: string, overrides: Partial<Note> = {}): Note {
	return {
		id,
		book_id: 7,
		highlight_id: highlightId,
		body_md: body,
		created_at: '2026-11-01T10:00:00Z',
		updated_at: '2026-11-01T10:00:00Z',
		deleted_at: null,
		rev: 1,
		...overrides
	};
}

function mark(id: string, overrides: Partial<Highlight> = {}, notes: Note[] = []): Mark {
	return { ...highlight(id, overrides), notes };
}

describe('buildMarks', () => {
	it('keeps live highlights and attaches only their live notes in creation order', () => {
		const marks = buildMarks(
			[highlight('a'), highlight('b', { deleted_at: '2026-11-02T00:00:00Z' }), highlight('c')],
			[
				note('n2', 'a', 'second', { created_at: '2026-11-03T00:00:00Z' }),
				note('n1', 'a', 'first', { created_at: '2026-11-02T00:00:00Z' }),
				note('gone', 'a', 'deleted', { deleted_at: '2026-11-04T00:00:00Z' }),
				note('orphan', 'b', 'on a deleted highlight'),
				note('book', null, 'book-level review')
			]
		);
		expect(marks.map((item) => item.id)).toEqual(['a', 'c']);
		expect(marks[0].notes.map((item) => item.id)).toEqual(['n1', 'n2']);
		expect(marks[1].notes).toEqual([]);
	});

	it('returns an empty list for an empty book', () => {
		expect(buildMarks([], [note('book', null, 'review')])).toEqual([]);
	});
});

describe('filterMarks', () => {
	it('normalizes missing styles and combines style filters with existing filters', () => {
		const marks = buildMarks([
			highlight('legacy'),
			highlight('underlined', { style: 'underline', color: 'green' }),
			highlight('struck', { style: 'strikeout' })
		], []);
		expect(marks[0].style).toBe('highlight');
		expect(filterMarks(marks, { query: '', colors: new Set(), styles: new Set(['highlight']), notesOnly: false }).map((row) => row.id)).toEqual(['legacy']);
		expect(filterMarks(marks, { query: 'underlined', colors: new Set(['green']), styles: new Set(['underline', 'strikeout']), notesOnly: false }).map((row) => row.id)).toEqual(['underlined']);
		expect(filterMarks(marks, { query: '', colors: new Set(), styles: new Set(['strikeout']), notesOnly: true })).toEqual([]);
	});
	const marks = [
		mark('a', { text: 'Le café était fermé', color: 'yellow' }),
		mark('b', { text: 'Nothing special', color: 'blue' }, [note('n', 'b', 'A **Résumé** idea')]),
		mark('c', { text: 'Another line', color: 'red' })
	];
	const none = new Set<string>();

	it('matches text and notes case- and diacritic-insensitively', () => {
		expect(filterMarks(marks, { query: 'CAFE ETAIT', colors: none, notesOnly: false }).map((m) => m.id)).toEqual(['a']);
		expect(filterMarks(marks, { query: 'resume', colors: none, notesOnly: false }).map((m) => m.id)).toEqual(['b']);
		expect(filterMarks(marks, { query: '  ', colors: none, notesOnly: false })).toHaveLength(3);
	});

	it('filters by colours and notes', () => {
		expect(filterMarks(marks, { query: '', colors: new Set(['yellow', 'red']), notesOnly: false }).map((m) => m.id)).toEqual(['a', 'c']);
		expect(filterMarks(marks, { query: '', colors: none, notesOnly: true }).map((m) => m.id)).toEqual(['b']);
		expect(filterMarks(marks, { query: 'line', colors: new Set(['yellow']), notesOnly: false })).toEqual([]);
	});
});

describe('sortMarks', () => {
	const marks = [
		mark('a', { position: 0.5, created_at: '2026-11-03T00:00:00Z' }),
		mark('b', { position: 0.1, created_at: '2026-11-05T00:00:00Z' }),
		mark('c', { position: 0.5, created_at: '2026-11-01T00:00:00Z' })
	];

	it('sorts by reading position then creation', () => {
		expect(sortMarks(marks, 'reading').map((m) => m.id)).toEqual(['b', 'c', 'a']);
	});

	it('sorts by newest and oldest without mutating the input', () => {
		expect(sortMarks(marks, 'newest').map((m) => m.id)).toEqual(['b', 'a', 'c']);
		expect(sortMarks(marks, 'oldest').map((m) => m.id)).toEqual(['c', 'a', 'b']);
		expect(marks.map((m) => m.id)).toEqual(['a', 'b', 'c']);
	});

	it('parses the sort parameter with a reading-order fallback', () => {
		expect(parseMarkSort('newest')).toBe('newest');
		expect(parseMarkSort('bogus')).toBe('reading');
		expect(parseMarkSort(null)).toBe('reading');
	});
});

describe('groupByChapter', () => {
	it('keeps first-appearance order, merges repeats and names missing chapters', () => {
		const groups = groupByChapter([
			mark('a', { chapter: 'Two' }),
			mark('b', { chapter: null }),
			mark('c', { chapter: 'One' }),
			mark('d', { chapter: 'Two' }),
			mark('e', { chapter: '  ' })
		], 'Untitled section');
		expect(groups.map((group) => [group.chapter, group.untitled, group.marks.map((m) => m.id)])).toEqual([
			['Two', false, ['a', 'd']],
			['Untitled section', true, ['b', 'e']],
			['One', false, ['c']]
		]);
		expect(groupByChapter([])).toEqual([]);
	});
});

describe('colorCounts and colorTone', () => {
	it('counts colours, most frequent first', () => {
		const counts = colorCounts([mark('a', { color: 'blue' }), mark('b', { color: 'yellow' }), mark('c', { color: 'blue' }), mark('d', { color: 'green' })]);
		expect(counts).toEqual([{ color: 'blue', count: 2 }, { color: 'yellow', count: 1 }, { color: 'green', count: 1 }]);
	});

	it('maps known colours to tones and unknown ones to slate', () => {
		for (const color of ['yellow', 'blue', 'red', 'orange', 'green', 'purple', 'pink']) {
			expect(colorTone(color).bar).not.toBe('bg-slate-400');
		}
		expect(colorTone('Blue').bar).toBe('bg-sky-500');
		expect(colorTone('teal').bar).toBe('bg-slate-400');
		expect(colorTone('toString').bar).toBe('bg-slate-400');
		expect(colorTone('#A1B2C3')).toMatchObject({ bar: '', hex: '#a1b2c3' });
		expect(colorTone('blue').hex).toBe('#60a5fa');
		for (const color of ['teal', 'red', 'Blue', '#abc']) {
			expect(colorTone(color).hex).toBe('#facc15');
		}
	});

	it('groups equivalent colours and orders filter options by preset then custom hex', () => {
		const marks = [
			mark('a', { color: '#ABCDEF' }), mark('b', { color: '#123456' }),
			mark('c', { color: '#F87171' }), mark('d', { color: 'yellow' }),
			mark('e', { color: '#FACC15' }), mark('f', { color: 'blue' }),
			mark('g', { color: '#abcdef' })
		];
		const counts = colorCounts(marks);
		expect(counts).toContainEqual({ color: 'yellow', count: 2 });
		expect(counts).toContainEqual({ color: '#abcdef', count: 2 });
		expect(sortColorOptions(counts).map((item) => item.color)).toEqual([
			'yellow', '#f87171', 'blue', '#123456', '#abcdef'
		]);
		expect(filterMarks(marks, { query: '', colors: new Set(['yellow', '#abcdef']), notesOnly: false }).map((item) => item.id))
			.toEqual(['a', 'd', 'e', 'g']);
	});
});

describe('markStats', () => {
	const now = new Date(2026, 10, 7, 12); // Saturday 7 Nov 2026, local time

	it('counts totals, chapters, colours and formats', () => {
		const stats = markStats([
			mark('a', { book_file_id: 70, chapter: 'One' }),
			mark('b', { book_file_id: 71, chapter: 'Two', color: 'blue' }),
			mark('c', { book_file_id: 99, chapter: 'Two' }),
			mark('d', { book_file_id: null, chapter: null })
		], now, [{ id: 70, format: 'EPUB' }, { id: 71, format: 'pdf' }]);
		expect(stats.total).toBe(4);
		expect(stats.chapters).toBe(3);
		expect(stats.byColor).toEqual([{ color: 'yellow', count: 3 }, { color: 'blue', count: 1 }]);
		expect(stats.byFormat).toEqual([
			{ format: UNKNOWN_FORMAT, count: 2 },
			{ format: 'epub', count: 1 },
			{ format: 'pdf', count: 1 }
		]);
	});

	it('buckets the last 52 ISO weeks and finds the busiest one', () => {
		const local = (y: number, mo: number, d: number) => new Date(y, mo, d, 9).toISOString();
		const stats = markStats([
			mark('a', { created_at: local(2026, 10, 2) }), // Monday of the current week
			mark('b', { created_at: local(2026, 10, 7) }),
			mark('c', { created_at: local(2026, 9, 28) }), // previous week
			mark('d', { created_at: local(2026, 9, 29) }),
			mark('e', { created_at: local(2026, 9, 30) }),
			mark('f', { created_at: local(2024, 0, 1) }), // too old
			mark('g', { created_at: 'not a date' })
		], now);
		expect(stats.weeks).toHaveLength(52);
		expect(stats.weeks.at(-1)).toEqual({ start: '2026-11-02', count: 2 });
		expect(stats.weeks.at(-2)).toEqual({ start: '2026-10-26', count: 3 });
		expect(stats.weeks[0].start).toBe('2025-11-10');
		expect(stats.weeks.reduce((sum, week) => sum + week.count, 0)).toBe(5);
		expect(stats.busiestWeek).toEqual({ start: '2026-10-26', count: 3 });
	});

	it('handles an empty book', () => {
		const stats = markStats([], now);
		expect(stats).toMatchObject({ total: 0, chapters: 0, byColor: [], byFormat: [], busiestWeek: null });
		expect(stats.weeks.every((week) => week.count === 0)).toBe(true);
	});

	it('computes ISO week starts and parses them back', () => {
		expect(isoWeekStart(new Date(2026, 10, 8, 23)).getDate()).toBe(2); // Sunday belongs to the week starting Monday 2nd
		expect(isoWeekStart(new Date(2026, 10, 2, 0)).getDate()).toBe(2);
		expect(weekStartDate('2026-03-30').getMonth()).toBe(2);
	});
});

describe('matchSegments', () => {
	it('marks folded matches in the original text', () => {
		expect(matchSegments('Le Café ouvert, café fermé', 'cafe')).toEqual([
			{ text: 'Le ', match: false },
			{ text: 'Café', match: true },
			{ text: ' ouvert, ', match: false },
			{ text: 'café', match: true },
			{ text: ' fermé', match: false }
		]);
	});

	it('returns the whole text without a query and nothing for empty text', () => {
		expect(matchSegments('Plain', '')).toEqual([{ text: 'Plain', match: false }]);
		expect(matchSegments('', 'x')).toEqual([]);
		expect(matchSegments('abc', 'zzz')).toEqual([{ text: 'abc', match: false }]);
	});

	it('handles decomposed input and astral characters', () => {
		expect(matchSegments('e\u0301t\u00e9 📚 ete', 'ETE')).toEqual([
			{ text: 'e\u0301t\u00e9', match: true },
			{ text: ' 📚 ', match: false },
			{ text: 'ete', match: true }
		]);
	});
});
