interface Writer {
	flush(options: { keepalive: boolean; signal: AbortSignal }): Promise<void>;
}

export async function flushReaderWrites(
	progress: Writer | null,
	retired: Set<Writer>,
	sessions: Writer
): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 2500);
	try {
		const writers = [...retired, ...(progress ? [progress] : [])];
		await Promise.race([
			Promise.all([
				...writers.map(async (writer) => {
					await writer.flush({ keepalive: true, signal: controller.signal });
					retired.delete(writer);
				}),
				sessions.flush({ keepalive: true, signal: controller.signal })
			]),
			new Promise<never>((_, reject) => {
				controller.signal.addEventListener('abort', () => reject(new Error('Reader save timed out.')), { once: true });
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}
