interface Writer {
	flush(options: { keepalive: boolean; signal: AbortSignal; sync?: boolean }): Promise<void>;
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
					// Progress is durable in IndexedDB; do not make closing wait for the push.
					await writer.flush({ keepalive: true, signal: controller.signal, sync: false });
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
