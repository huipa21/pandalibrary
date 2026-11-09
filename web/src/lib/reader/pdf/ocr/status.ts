export type OcrStatus =
	| { state: 'idle' }
	| { state: 'loading'; page: number }
	| { state: 'recognizing'; page: number; progress: number }
	| { state: 'error'; page: number; error: unknown; retry: () => void };
