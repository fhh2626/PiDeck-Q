import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScanReadQueue } from "./ScanReadQueue";

/** Extract only session identities, never retain the original (possibly nested) run record. */
function collectSessionFiles(value: unknown, result: Set<string>, normalize: (path: string) => string): void {
	if (!value || typeof value !== "object") return;
	if ("sessionFile" in value && typeof value.sessionFile === "string" && value.sessionFile.trim()) {
		result.add(normalize(value.sessionFile.trim()));
	}
	const children: unknown[] = Object.values(value);
	for (const child of children) collectSessionFiles(child, result, normalize);
}

/** Bounded asynchronous snapshot of local pi-subagents records, preserving legacy depth/layout rules. */
export async function readSubagentRecords(
	temporaryRoot: string,
	customRoot: string | undefined,
	normalize: (path: string) => string,
	queue: ScanReadQueue,
	signal?: AbortSignal,
): Promise<Set<string>> {
	const result = new Set<string>();
	const visit = async (directory: string, depth: number): Promise<void> => {
		signal?.throwIfAborted();
		if (depth < 0) return;
		try {
			const entries = await queue.run(() => readdir(directory, { withFileTypes: true }), signal);
			await Promise.all(entries.map(async (entry) => {
				const path = join(directory, entry.name);
				if (entry.isFile() && entry.name.endsWith(".json")) {
					try {
						await queue.run(async (readSignal) => {
							const text = await readFile(path, { encoding: "utf8", signal: readSignal });
							const value: unknown = JSON.parse(text);
							collectSessionFiles(value, result, normalize);
						}, signal);
					} catch { signal?.throwIfAborted(); }
				} else if (entry.isDirectory() && !entry.name.startsWith(".")) await visit(path, depth - 1);
			}));
		} catch { signal?.throwIfAborted(); }
	};
	try {
		const entries = await queue.run(() => readdir(temporaryRoot, { withFileTypes: true }), signal);
		await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-subagents-"))
			.map((entry) => visit(join(temporaryRoot, entry.name), 3)));
	} catch { signal?.throwIfAborted(); }
	if (customRoot) await visit(customRoot, 3);
	return result;
}
