import { randomUUID } from "node:crypto";

export const EXTERNAL_FILE_CAPABILITY_NOT_AUTHORIZED_CODE = "EXTERNAL_FILE_CAPABILITY_NOT_AUTHORIZED";

const CAPABILITY_TTL_MS = 30_000;
const MAX_CAPABILITIES = 256;
const MAX_PATHS_PER_CAPABILITY = 128;

export class ExternalFileCapabilityError extends Error {
	readonly code = EXTERNAL_FILE_CAPABILITY_NOT_AUTHORIZED_CODE;

	constructor() {
		super("The external file capability is missing, expired, or does not include this path.");
		this.name = "ExternalFileCapabilityError";
	}
}

type CapabilityEntry = {
	paths: string[];
	expiresAt: number;
};

function normalizePath(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function validCapabilityId(capabilityId: string): boolean {
	return typeof capabilityId === "string" && capabilityId.length > 0 && capabilityId.length <= 128;
}

/**
 * Short-lived capability registry for paths obtained from a trusted OS event.
 * Renderer input is never used to issue a capability; it can only redeem one
 * that the native host attached to a clipboard/drop payload.
 */
export class ExternalFileCapabilityStore {
	private readonly capabilities = new Map<string, CapabilityEntry>();

	issue(paths: readonly string[]): string | null {
		this.pruneExpired();
		const uniquePaths: string[] = [];
		const seen = new Set<string>();
		for (const path of paths) {
			if (typeof path !== "string" || path.length === 0) continue;
			const key = normalizePath(path);
			if (seen.has(key)) continue;
			seen.add(key);
			uniquePaths.push(path);
			if (uniquePaths.length >= MAX_PATHS_PER_CAPABILITY) break;
		}
		if (uniquePaths.length === 0) return null;
		while (this.capabilities.size >= MAX_CAPABILITIES) {
			const oldest = this.capabilities.keys().next().value;
			if (typeof oldest !== "string") break;
			this.capabilities.delete(oldest);
		}
		const capabilityId = randomUUID();
		this.capabilities.set(capabilityId, {
			paths: uniquePaths,
			expiresAt: Date.now() + CAPABILITY_TTL_MS,
		});
		return capabilityId;
	}

	consumeCopy(capabilityId: string): string[] {
		const entry = this.takeEntry(capabilityId);
		return [...entry.paths];
	}

	/** Redeem one exact trusted path; the path supplied by the renderer is only a selector. */
	consumeRead(capabilityId: string, requestedPath: string): string {
		const entry = this.getEntry(capabilityId);
		const requestedKey = normalizePath(requestedPath);
		const index = entry.paths.findIndex((path) => normalizePath(path) === requestedKey);
		if (index < 0) throw new ExternalFileCapabilityError();
		const [trustedPath] = entry.paths.splice(index, 1);
		if (entry.paths.length === 0) this.capabilities.delete(capabilityId);
		return trustedPath;
	}

	revoke(capabilityId: string): void {
		if (validCapabilityId(capabilityId)) this.capabilities.delete(capabilityId);
	}

	clear(): void {
		this.capabilities.clear();
	}

	private getEntry(capabilityId: string): CapabilityEntry {
		if (!validCapabilityId(capabilityId)) throw new ExternalFileCapabilityError();
		const entry = this.capabilities.get(capabilityId);
		if (!entry || entry.expiresAt <= Date.now()) {
			this.capabilities.delete(capabilityId);
			throw new ExternalFileCapabilityError();
		}
		return entry;
	}

	private takeEntry(capabilityId: string): CapabilityEntry {
		const entry = this.getEntry(capabilityId);
		this.capabilities.delete(capabilityId);
		return entry;
	}

	private pruneExpired(): void {
		const now = Date.now();
		for (const [capabilityId, entry] of this.capabilities) {
			if (entry.expiresAt <= now) this.capabilities.delete(capabilityId);
		}
	}
}
