export interface SearchSeries {
	readonly id: number;
	readonly name: string;
	readonly index: number | null;
}

/** One S1 search hit. Lower `rank` values are more relevant; 0 means an unranked substring match. */
export interface SearchResult {
	readonly id: number;
	readonly title: string;
	readonly authors: string[];
	readonly series: SearchSeries | null;
	readonly cover_url: string | null;
	readonly rank: number;
}
