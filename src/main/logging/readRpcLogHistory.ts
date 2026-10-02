import { createReadStream } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import type { RpcLogEntry } from "../../shared/types/rpcLog";

const MAX_HISTORY_SCAN_BYTES = 128 * 1024 * 1024;
const MAX_HISTORY_LINE_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_RESULT_BYTES = 8 * 1024 * 1024;

/** Scan limits fail explicitly rather than silently returning an incomplete date range. */
class RpcLogHistoryLimitError extends Error {
	readonly code = "RPC_LOG_HISTORY_LIMIT_EXCEEDED";
	constructor() { super("RPC log history exceeds the bounded query budget; narrow the date range."); }
}

/** Disk JSON is untrusted, including old/corrupt log rows. */
function isLogEntry(value: unknown): value is RpcLogEntry {
	return Boolean(value && typeof value === "object" &&
		"id" in value && typeof value.id === "string" &&
		"agentId" in value && typeof value.agentId === "string" &&
		"direction" in value && typeof value.direction === "string" &&
		"summary" in value && typeof value.summary === "string" &&
		"time" in value && typeof value.time === "number" && Number.isFinite(value.time));
}

/** Stream JSONL (including gzip) without holding a full archive or inflated file in memory. */
async function readLines(path: string, budget: { remaining: number }, visit: (line: string) => void): Promise<void> {
	const source = createReadStream(path);
	const gunzip = path.endsWith(".gz") ? createGunzip() : undefined;
	const stream = gunzip ? source.pipe(gunzip) : source;
	const onError = (error: Error) => gunzip?.destroy(error);
	source.on("error", onError);
	const decoder = new StringDecoder("utf8");
	let pending = "";
	const consume = (text: string) => {
		pending += text;
		let end: number;
		while ((end = pending.indexOf("\n")) >= 0) {
			const line = pending.slice(0, end);
			pending = pending.slice(end + 1);
			if (Buffer.byteLength(line, "utf8") > MAX_HISTORY_LINE_BYTES) throw new RpcLogHistoryLimitError();
			visit(line);
		}
		if (Buffer.byteLength(pending, "utf8") > MAX_HISTORY_LINE_BYTES) throw new RpcLogHistoryLimitError();
	};
	try {
		for await (const chunk of stream) {
			if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected RPC history stream chunk");
			budget.remaining -= chunk.length;
			if (budget.remaining < 0) throw new RpcLogHistoryLimitError();
			consume(decoder.write(chunk));
		}
		consume(decoder.end());
		if (pending.trim()) visit(pending);
	} finally {
		source.off("error", onError);
		source.destroy();
		gunzip?.destroy();
	}
}

/** Read a date-filtered set of archives and retain only the globally newest bounded entries. */
export async function readRpcLogHistory(
	directory: string,
	files: string[],
	options: { limit: number; cutoff: number; agentId?: string },
): Promise<RpcLogEntry[]> {
	const budget = { remaining: MAX_HISTORY_SCAN_BYTES };
	const entries: Array<{ entry: RpcLogEntry; bytes: number }> = [];
	let resultBytes = 0;
	const visit = (line: string) => {
		let entry: unknown;
		try { entry = JSON.parse(line); } catch { return; }
		if (!isLogEntry(entry) || entry.time < options.cutoff || (options.agentId && entry.agentId !== options.agentId)) return;
		const bytes = Buffer.byteLength(line, "utf8");
		// Binary insertion keeps the newest N across agents and files, even when
		// a viewer appends older saved entries to a file out of chronological order.
		let lo = 0;
		let hi = entries.length;
		while (lo < hi) {
			const middle = (lo + hi) >>> 1;
			if (entries[middle].entry.time > entry.time) lo = middle + 1;
			else hi = middle;
		}
		if (lo >= options.limit) return;
		entries.splice(lo, 0, { entry, bytes });
		resultBytes += bytes;
		while (entries.length > options.limit || resultBytes > MAX_HISTORY_RESULT_BYTES) {
			const removed = entries.pop();
			if (removed) resultBytes -= removed.bytes;
		}
	};
	for (const file of files) {
		try { await readLines(join(directory, file), budget, visit); }
		catch (error) {
			if (error instanceof RpcLogHistoryLimitError) throw error;
			// A removed or damaged archive must not hide valid records in other files.
		}
	}
	return entries.map(({ entry }) => entry);
}
