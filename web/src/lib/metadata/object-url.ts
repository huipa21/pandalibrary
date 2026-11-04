export interface ObjectUrlApi {
	createObjectURL(blob: Blob): string;
	revokeObjectURL(url: string): void;
}

/** Holds at most one object URL and revokes it whenever it is replaced or cleared. */
export class ObjectUrlSlot {
	private current: string | null = null;

	constructor(private readonly urls: ObjectUrlApi = URL) {}

	get url(): string | null {
		return this.current;
	}

	set(blob: Blob): string {
		this.clear();
		this.current = this.urls.createObjectURL(blob);
		return this.current;
	}

	clear(): void {
		if (this.current !== null) this.urls.revokeObjectURL(this.current);
		this.current = null;
	}
}
