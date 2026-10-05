import { createHash, type Hash } from "node:crypto";
import { stat, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";

export type SessionFileVersion = Pick<Stats, "size" | "mtimeMs" | "ctimeMs" | "dev" | "ino">;
export type SessionFileSnapshot = SessionFileVersion & { hostPath: string; prefixDigest: string };

/** Cache identity is still exact: append creates a new version for the next request. */
export function sessionFileFingerprint(version: SessionFileVersion): string {
	return JSON.stringify([version.dev, version.ino, version.size, version.mtimeMs, version.ctimeMs]);
}

/** Path replacement and truncation cannot be mistaken for a safe tail append. */
export function containsSessionSnapshot(version: SessionFileVersion, snapshot: SessionFileVersion): boolean {
	return version.dev === snapshot.dev && version.ino === snapshot.ino && version.size >= snapshot.size;
}

/** Complete short reads; never hash or parse uninitialized buffer bytes. */
export async function readSessionFileRange(handle: FileHandle, length: number, position: number): Promise<Buffer> {
	const buffer = Buffer.allocUnsafe(length);
	let filled = 0;
	while (filled < length) {
		const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
		if (!bytesRead) throw new Error("SESSION_HISTORY_CHANGED");
		filled += bytesRead;
	}
	return buffer;
}

/** Hash only the pinned prefix with bounded buffers, regardless of how large the new tail becomes. */
export async function hashSessionFilePrefix(handle: FileHandle, size: number): Promise<Hash> {
	const hash = createHash("sha256");
	for (let offset = 0; offset < size; offset += 64 * 1024) {
		hash.update(await readSessionFileRange(handle, Math.min(64 * 1024, size - offset), offset));
	}
	return hash;
}

/**
 * A reader needs a coherent pinned prefix, not a globally idle log file. If the
 * version changed, verify ALL old bytes before accepting append. Selected rows
 * additionally verify their indexed digest, preventing mixed bodies during I/O.
 * The returned fingerprint is local to this read and avoids a redundant prefix
 * pass when the same descriptor/path version remains unchanged at read end.
 */
export async function validateSessionFileSnapshot(
	handle: FileHandle, snapshot: SessionFileSnapshot, validatedFingerprint = sessionFileFingerprint(snapshot), finalCheck = false,
): Promise<string> {
	const descriptor = await handle.stat();
	const named = await stat(snapshot.hostPath);
	if (!containsSessionSnapshot(descriptor, snapshot) || !containsSessionSnapshot(named, snapshot)) {
		throw new Error("SESSION_HISTORY_CHANGED");
	}
	if (sessionFileFingerprint(descriptor) === validatedFingerprint
		&& sessionFileFingerprint(named) === validatedFingerprint) return validatedFingerprint;
	const hash = await hashSessionFilePrefix(handle, snapshot.size);
	if (hash.digest("hex") !== snapshot.prefixDigest) throw new Error("SESSION_HISTORY_CHANGED");
	const after = await handle.stat();
	const afterNamed = await stat(snapshot.hostPath);
	if (!containsSessionSnapshot(after, snapshot) || !containsSessionSnapshot(afterNamed, snapshot)) {
		throw new Error("SESSION_HISTORY_CHANGED");
	}
	// Same-size edits while validating are not append; don't bless their final
	// fingerprint after hashing bytes from an earlier moment.
	if ((sessionFileFingerprint(after) !== sessionFileFingerprint(descriptor) && after.size <= descriptor.size)
		|| (sessionFileFingerprint(after) !== sessionFileFingerprint(afterNamed) && afterNamed.size <= after.size)) {
		throw new Error("SESSION_HISTORY_CHANGED");
	}
	if (finalCheck && (sessionFileFingerprint(after) !== sessionFileFingerprint(descriptor)
		|| sessionFileFingerprint(afterNamed) !== sessionFileFingerprint(named))) {
		// A writer may have changed bytes behind the validation cursor. Confirm
		// the same fixed prefix once more before publishing; ongoing pure append
		// still succeeds without waiting for the entire file to become idle.
		const confirmation = await hashSessionFilePrefix(handle, snapshot.size);
		if (confirmation.digest("hex") !== snapshot.prefixDigest) throw new Error("SESSION_HISTORY_CHANGED");
		const confirmed = await handle.stat();
		const confirmedNamed = await stat(snapshot.hostPath);
		if (!containsSessionSnapshot(confirmed, snapshot) || !containsSessionSnapshot(confirmedNamed, snapshot)
			|| (sessionFileFingerprint(confirmed) !== sessionFileFingerprint(after) && confirmed.size <= after.size)
			|| (sessionFileFingerprint(confirmed) !== sessionFileFingerprint(confirmedNamed) && confirmedNamed.size <= confirmed.size)) {
			throw new Error("SESSION_HISTORY_CHANGED");
		}
	}
	// Do not bless a version that appeared DURING the hash pass: its write may
	// include an edit behind the read cursor, not just append. Returning the
	// pre-pass fingerprint forces the post-body check to verify that prefix again.
	return sessionFileFingerprint(descriptor);
}
