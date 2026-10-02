import type { SessionCatalogEntry, SessionFilePathResolver } from "./SessionCatalog";

/** Native drive/UNC paths and WSL POSIX paths must not use host-only path rules. */
function isAbsoluteSessionPath(entry: SessionCatalogEntry): boolean {
	const path = entry.filePath;
	if (!path) return false;
	return entry.environment === "wsl"
		? path.startsWith("/")
		: /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path);
}

type MigrationCandidate = { entry: SessionCatalogEntry; wasRelative: boolean };

/**
 * Preserve the original runtime-relative identity before scan-created duplicates.
 * Already normalized catalogs use earliest creation time, with disk order as the
 * tie-breaker. Preferences belong to that identity; only missing values are filled.
 */
function mergeCollision(group: MigrationCandidate[]): SessionCatalogEntry {
	const preferred = [...group].sort((left, right) =>
		Number(right.wasRelative) - Number(left.wasRelative) ||
		left.entry.createdAt - right.entry.createdAt,
	);
	const winner = preferred[0];
	if (!winner) throw new Error("Cannot merge an empty session collision");
	const recent = group.map(candidate => candidate.entry)
		.sort((left, right) => right.updatedAt - left.updatedAt);
	const scanMetadata: NonNullable<SessionCatalogEntry["scanMetadata"]> = {};
	let hasScanMetadata = false;
	// New scans may omit optional fields. Overlay oldest-to-newest to retain
	// missing metadata without allowing stale previews to overwrite recent ones.
	for (const entry of [...recent].reverse()) {
		if (!entry.scanMetadata) continue;
		Object.assign(scanMetadata, entry.scanMetadata);
		hasScanMetadata = true;
	}
	return {
		...winner.entry,
		model: winner.entry.model ?? recent.find(entry => entry.model !== undefined)?.model,
		thinkingLevel: winner.entry.thinkingLevel ?? recent.find(entry => entry.thinkingLevel !== undefined)?.thinkingLevel,
		piSessionId: winner.entry.piSessionId ?? recent.find(entry => entry.piSessionId !== undefined)?.piSessionId,
		scanMetadata: hasScanMetadata ? scanMetadata : undefined,
		isInternalSubagent: recent.find(entry => entry.isInternalSubagent !== undefined)?.isInternalSubagent,
		parentSessionPath: recent.find(entry => entry.parentSessionPath !== undefined)?.parentSessionPath,
		createdAt: recent.reduce((minimum, entry) => Math.min(minimum, entry.createdAt), winner.entry.createdAt),
		updatedAt: recent.reduce((maximum, entry) => Math.max(maximum, entry.updatedAt), winner.entry.updatedAt),
	};
}

/** Normalize old paths and consolidate durable origin collisions; never merge unresolved paths. */
export function migrateSessionCatalogEntries(
	entries: SessionCatalogEntry[],
	resolveFilePath: SessionFilePathResolver | undefined,
	originKeyForEntry: (entry: SessionCatalogEntry) => string | undefined,
): SessionCatalogEntry[] | undefined {
	let changed = false;
	const groups = new Map<string, MigrationCandidate[]>();
	const order: Array<MigrationCandidate | MigrationCandidate[]> = [];
	for (const original of entries) {
		const wasRelative = Boolean(original.filePath) && !isAbsoluteSessionPath(original);
		let entry = original;
		if (original.filePath && resolveFilePath) {
			const resolved = resolveFilePath(original.projectId, original.filePath, original.environment);
			if (resolved && resolved !== original.filePath) {
				entry = { ...original, filePath: resolved };
				entry.originKey = originKeyForEntry(entry);
				changed = true;
			}
		}
		// Missing projects can leave identical relative strings referring to
		// different files. Anonymous/fileless entries likewise have no disk identity.
		const canGroup = !entry.noSession && isAbsoluteSessionPath(entry);
		const originKey = canGroup ? entry.originKey ?? originKeyForEntry(entry) : undefined;
		if (originKey && entry.originKey !== originKey) {
			entry = { ...entry, originKey };
			changed = true;
		}
		const candidate = { entry, wasRelative };
		if (!originKey) {
			order.push(candidate);
			continue;
		}
		const group = groups.get(originKey);
		if (group) {
			group.push(candidate);
			changed = true;
		} else {
			const nextGroup = [candidate];
			groups.set(originKey, nextGroup);
			order.push(nextGroup);
		}
	}
	if (!changed) return undefined;
	return order.map(item => {
		if (!Array.isArray(item)) return item.entry;
		if (item.length > 1) return mergeCollision(item);
		const only = item[0];
		if (!only) throw new Error("Empty session migration group");
		return only.entry;
	});
}
