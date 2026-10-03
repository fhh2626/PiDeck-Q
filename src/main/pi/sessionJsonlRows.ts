import type { FileHandle } from "node:fs/promises";

export type SessionJsonlRow = { text: string; offset: number; byteLength: number; terminated: boolean };

/** Stream a fixed byte range, joining fragments once per row instead of copying a growing file. */
export async function* sessionJsonlRows(
	handle: FileHandle,
	start: number,
	end: number,
	onChunk?: (chunk: Buffer) => void,
): AsyncGenerator<SessionJsonlRow> {
	let position = start;
	let rowOffset = start;
	let fragments: Buffer[] = [];
	let fragmentBytes = 0;
	let rowsSinceYield = 0;
	while (position < end) {
		const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, end - position));
		const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
		if (bytesRead === 0) throw new Error("SESSION_HISTORY_CHANGED");
		onChunk?.(chunk.subarray(0, bytesRead));
		position += bytesRead;
		let from = 0;
		while (from < bytesRead) {
			const boundary = chunk.indexOf(10, from);
			if (boundary < 0 || boundary >= bytesRead) {
				const tail = chunk.subarray(from, bytesRead);
				fragments.push(tail); fragmentBytes += tail.length;
				break;
			}
			const tail = chunk.subarray(from, boundary);
			const length = fragmentBytes + tail.length;
			const row = fragments.length > 0 ? Buffer.concat([...fragments, tail], length) : tail;
			yield { text: row.toString("utf8"), offset: rowOffset, byteLength: length, terminated: true };
			rowOffset += length + 1;
			fragments = []; fragmentBytes = 0;
			from = boundary + 1;
			// Small rows must not monopolize the event loop through a long microtask chain.
			if (++rowsSinceYield >= 256) { await new Promise<void>((resolve) => setImmediate(resolve)); rowsSinceYield = 0; }
		}
	}
	if (fragmentBytes > 0) {
		yield { text: Buffer.concat(fragments, fragmentBytes).toString("utf8"), offset: rowOffset, byteLength: fragmentBytes, terminated: false };
	}
}
