import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Temp-file-then-rename JSON write, so a concurrent reader never observes a half-written file.
 * The temp file is always removed: on Windows a failed rename can otherwise leave one locked
 * behind, and a leftover temp file must never be mistaken for a published snapshot.
 */
export function writeJsonAtomic(filePath: string, payload: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp.${Date.now()}.${process.pid}`;
	try {
		writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
		renameSync(tmpPath, filePath);
	} finally {
		try {
			if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
		} catch {
			// Best effort: the write/rename outcome is what the caller needs.
		}
	}
}
