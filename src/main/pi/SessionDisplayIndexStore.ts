import { open, stat, type FileHandle } from "node:fs/promises";
import { createHash, type Hash } from "node:crypto";
import { sessionJsonlRows, type SessionJsonlRow } from "./sessionJsonlRows";
import { containsSessionSnapshot, hashSessionFilePrefix, readSessionFileRange as readRange,
	sessionFileFingerprint as fingerprint, validateSessionFileSnapshot, type SessionFileVersion } from "./sessionFileSnapshot";

export type SessionDisplayEntry = {
	id: string; parentId: string | null; type: string; offset: number; byteLength: number; rowDigest: string;
	hasMessage: boolean; hasTruthyMessage: boolean; role?: string; messageId?: string;
	summary?: string; firstKeptEntryId?: string; timestamp?: string; tokensBefore?: number;
};
export type SessionCompaction = {
	id: string; summary: string; timestamp: string; firstKeptEntryId?: string; tokensBefore?: number;
};
export type SessionDisplayIndex = SessionFileVersion & {
	hostPath: string; prefixDigest: string; hasCompaction: boolean; endsWithNewline: boolean; rowCount: number;
	entries: Map<string, SessionDisplayEntry>;
	activeBranch: SessionDisplayEntry[]; activeMessageEntries: SessionDisplayEntry[];
	firstEntries: Map<string, SessionDisplayEntry>; firstMessages: Map<string, SessionDisplayEntry>;
	compactions: SessionCompaction[];
};
type IndexParts = Pick<SessionDisplayIndex, "entries" | "firstEntries" | "firstMessages" | "compactions" | "rowCount" | "endsWithNewline"> & { leafId?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse once, retaining offsets and metadata rather than historical message bodies. */
function addRow(parts: IndexParts, row: SessionJsonlRow): SessionDisplayEntry | undefined {
	parts.rowCount += 1; parts.endsWithNewline = row.terminated;
	let value: unknown;
	try { value = JSON.parse(row.text); } catch { return undefined; }
	if (!isRecord(value)) return undefined;
	const message = isRecord(value.message) ? value.message : undefined;
	const entry: SessionDisplayEntry = {
		id: typeof value.id === "string" ? value.id : "",
		parentId: typeof value.parentId === "string" ? value.parentId : null,
		type: typeof value.type === "string" ? value.type : "",
		offset: row.offset, byteLength: row.byteLength,
		rowDigest: createHash("sha256").update(row.text).digest("hex"),
		hasMessage: value.message !== undefined && value.message !== null,
		hasTruthyMessage: Boolean(value.message),
		role: typeof message?.role === "string" ? message.role : undefined,
		messageId: typeof message?.id === "string" ? message.id : undefined,
		summary: typeof value.summary === "string" ? value.summary : undefined,
		firstKeptEntryId: typeof value.firstKeptEntryId === "string" ? value.firstKeptEntryId : undefined,
		timestamp: typeof value.timestamp === "string" ? value.timestamp : undefined,
		tokensBefore: typeof value.tokensBefore === "number" ? value.tokensBefore : undefined,
	};
	// Full-text lookup is physical-first, unlike the active branch's last duplicate-id entry.
	if (typeof value.id === "string" && !parts.firstEntries.has(value.id)) parts.firstEntries.set(value.id, entry);
	if (entry.messageId !== undefined && !parts.firstMessages.has(entry.messageId)) parts.firstMessages.set(entry.messageId, entry);
	if (value.type === "compaction") parts.compactions.push({
		id: entry.id, summary: entry.summary ?? "", timestamp: entry.timestamp ?? "",
		firstKeptEntryId: entry.firstKeptEntryId, tokensBefore: entry.tokensBefore,
	});
	if (typeof value.id !== "string") return undefined;
	parts.entries.set(value.id, entry); parts.leafId = value.id;
	return entry;
}

/** Trace from the actual leaf; append and cold builds use exactly the same branch policy. */
function finish(hostPath: string, version: SessionFileVersion, parts: IndexParts, prefixDigest: string): SessionDisplayIndex {
	const branch: SessionDisplayEntry[] = [];
	const seen = new Set<string>();
	let current = parts.leafId ? parts.entries.get(parts.leafId) : undefined;
	while (current && !seen.has(current.id)) {
		seen.add(current.id); branch.push(current);
		current = current.parentId ? parts.entries.get(current.parentId) : undefined;
	}
	branch.reverse();
	return { ...version, ...parts, hostPath, prefixDigest, activeBranch: branch,
		hasCompaction: branch.some((entry) => entry.type === "compaction"),
		activeMessageEntries: branch.filter((entry) => entry.type === "message" && entry.hasMessage) };
}

/** LRU + single-flight display indexes. Runtime/Pi ownership remains outside this file reader. */
export class SessionDisplayIndexStore {
	private readonly cache = new Map<string, SessionDisplayIndex>();
	private readonly loading = new Map<string, { version: string; promise: Promise<SessionDisplayIndex> }>();

	constructor(private readonly limit = 32) {}

	async get(hostPath: string): Promise<SessionDisplayIndex> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const version = await stat(hostPath);
			const key = fingerprint(version);
			const cached = this.cache.get(hostPath);
			if (cached && fingerprint(cached) === key) { this.touch(hostPath, cached); return cached; }
			let pending = this.loading.get(hostPath);
			if (!pending || pending.version !== key) {
				const promise = this.build(hostPath, version, cached);
				pending = { version: key, promise }; this.loading.set(hostPath, pending);
			}
			try {
				const index = await pending.promise;
				// build validated its fixed prefix. A newer tail need not invalidate this
				// request; exact cache identity still makes the next request extend/rebuild.
				this.touch(hostPath, index); return index;
			} catch (error) {
				if (!isRecord(error) || error.message !== "SESSION_HISTORY_CHANGED" || attempt > 0) throw error;
			} finally {
				if (this.loading.get(hostPath) === pending) this.loading.delete(hostPath);
			}
		}
		throw new Error("SESSION_HISTORY_CHANGED");
	}

	private touch(path: string, index: SessionDisplayIndex): void {
		this.cache.delete(path); this.cache.set(path, index);
		while (this.cache.size > this.limit) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
	}

	private async build(path: string, requestedVersion: SessionFileVersion, cached?: SessionDisplayIndex): Promise<SessionDisplayIndex> {
		const handle = await open(path, "r");
		try {
			// Pin descriptor size/version once. An append between stat and open is
			// readable, but a replaced file or a shorter prefix must start a fresh load.
			const version = await handle.stat();
			if (!containsSessionSnapshot(version, requestedVersion)) throw new Error("SESSION_HISTORY_CHANGED");
			const prefixHash = cached && cached.dev === version.dev && cached.ino === version.ino &&
				version.size > cached.size && cached.endsWithNewline
				? await this.verifiedPrefix(handle, cached) : undefined;
			if (cached && prefixHash) {
				const parts: IndexParts = { entries: new Map(cached.entries), firstEntries: new Map(cached.firstEntries),
					firstMessages: new Map(cached.firstMessages), compactions: [...cached.compactions],
					rowCount: cached.rowCount, endsWithNewline: false, leafId: cached.activeBranch.at(-1)?.id };
				for await (const row of sessionJsonlRows(handle, cached.size, version.size, (chunk) => { prefixHash.update(chunk); })) {
					// Use the cold parser for every row: complete JSON needs no final LF. A truly
					// unfinished row is skipped, and endsWithNewline=false forces a rebuild when it grows.
					addRow(parts, row);
				}
				const index = finish(path, version, parts, prefixHash.digest("hex"));
				await validateSessionFileSnapshot(handle, index, undefined, true);
				return index;
			}
			const parts: IndexParts = { entries: new Map(), firstEntries: new Map(), firstMessages: new Map(),
				compactions: [], rowCount: 0, endsWithNewline: false };
			const hash = createHash("sha256");
			for await (const row of sessionJsonlRows(handle, 0, version.size, (chunk) => { hash.update(chunk); })) addRow(parts, row);
			const index = finish(path, version, parts, hash.digest("hex"));
			await validateSessionFileSnapshot(handle, index, undefined, true);
			return index;
		} finally { await handle.close(); }
	}

	/**
	 * A growing file is not necessarily append-only: an external editor can rewrite its middle.
	 * Verify the full prefix with bounded buffers before reusing parsed metadata. This costs a
	 * linear prefix read on a new version, but never silently serves an outdated branch.
	 */
	private async verifiedPrefix(handle: FileHandle, cached: SessionDisplayIndex): Promise<Hash | undefined> {
		const hash = await hashSessionFilePrefix(handle, cached.size);
		return hash.copy().digest("hex") === cached.prefixDigest ? hash : undefined;
	}

	/** Read only selected entries, coalescing adjacent rows without splitting or reordering messages. */
	async readMessages(index: SessionDisplayIndex, entries: readonly SessionDisplayEntry[]): Promise<unknown[]> {
		const handle = await open(index.hostPath, "r");
		try {
			const validatedVersion = await validateSessionFileSnapshot(handle, index);
			const result: unknown[] = [];
			let from = 0;
			while (from < entries.length) {
				let to = from + 1;
				let end = entries[from].offset + entries[from].byteLength;
				while (to < entries.length && entries[to].offset === end + 1 &&
					entries[to].offset + entries[to].byteLength - entries[from].offset <= 1024 * 1024) {
					end = entries[to].offset + entries[to].byteLength; to++;
				}
				const buffer = await readRange(handle, end - entries[from].offset, entries[from].offset);
				for (let i = from; i < to; i++) {
					const entry = entries[i]; const offset = entry.offset - entries[from].offset;
					const text = buffer.subarray(offset, offset + entry.byteLength).toString("utf8");
					// Prefix validation may overlap appends; served bodies must still be
					// exactly the indexed rows, not same-ID records from an in-place edit.
					if (createHash("sha256").update(text).digest("hex") !== entry.rowDigest) throw new Error("SESSION_HISTORY_CHANGED");
					const row: unknown = JSON.parse(text);
					if (!isRecord(row) || (entry.id && row.id !== entry.id)) throw new Error("SESSION_HISTORY_CHANGED");
					result.push(row.message);
				}
				from = to;
			}
			// Check both the descriptor and named path, retaining replacement protection.
			await validateSessionFileSnapshot(handle, index, validatedVersion, true);
			return result;
		} finally { await handle.close(); }
	}
}
