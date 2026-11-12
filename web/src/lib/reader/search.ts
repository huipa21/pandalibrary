export interface ReaderSearchResult {
	id: string;
	excerpt: { before: string; match: string; after: string };
	page?: number;
	label?: string;
}

export interface ReaderSearchEngine {
	search(query: string, signal?: AbortSignal): Promise<ReaderSearchResult[]>;
	goToSearchResult(result: ReaderSearchResult): Promise<void>;
	clearSearch(): void;
}
