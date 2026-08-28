import { randomUUID } from "node:crypto";

export const EXTERNAL_FILE_CAPABILITY_NOT_AUTHORIZED_CODE = "EXTERNAL_FILE_CAPABILITY_NOT_AUTHORIZED";

const CLIPBOARD_CAPABILITY_TTL_MS = 10 * 60_000;
const DROP_CAPABILITY_TTL_MS = 30_000;
const MAX_CAPABILITIES = 256;
const MAX_PATHS_PER_CAPABILITY = 128;

export class ExternalFileCapabilityError extends Error {
	readonly code = EXTERNAL_FILE_CAPABILITY_NOT_AUTHORIZED_CODE;

	constructor() {
		super("The external file capability is missing, expired, or does not include this path.");
		this.name = "ExternalFileCapabilityError";
	}
}

export type CapabilityKind = "clipboard" | "drop";

type CapabilityEntry = {
	paths: string[];
	sequence?: number;
	expiresAt: number;
	kind: CapabilityKind;
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
	private currentClipboardCapabilityId: string | null = null;

	/**
	 * Issue or reuse the capability for one clipboard sequence. The OS clipboard
	 * is reusable; sequence changes revoke the previous capability immediately.
	 */
	issueClipboard(paths: readonly string[], sequence?: number): string | null {
		this.pruneExpired();
		const currentId = this.currentClipboardCapabilityId;
		const current = currentId ? this.capabilities.get(currentId) : undefined;
		if (current && current.sequence === sequence) return currentId;
		if (currentId) this.deleteCapability(currentId);
		return this.createCapability(paths, "clipboard", sequence, CLIPBOARD_CAPABILITY_TTL_MS);
	}

	/** Issue a short-lived capability for one trusted native OS drop. */
	issueDrop(paths: readonly string[]): string | null {
		return this.createCapability(paths, "drop", undefined, DROP_CAPABILITY_TTL_MS);
	}

	consumeCopy(capabilityId: string): string[] {
		const entry = this.getEntry(capabilityId);
		if (entry.kind === "drop") this.deleteCapability(capabilityId);
		return [...entry.paths];
	}

	/**
	 * Redeem one exact trusted path; the path supplied by the renderer is only a
	 * selector. Clipboard capabilities remain reusable for the same sequence,
	 * while drop capabilities retain the previous one-read-per-path behavior.
	 */
	consumeRead(capabilityId: string, requestedPath: string): string {
		const entry = this.getEntry(capabilityId);
		const requestedKey = normalizePath(requestedPath);
		const index = entry.paths.findIndex((path) => normalizePath(path) === requestedKey);
		if (index < 0) throw new ExternalFileCapabilityError();
		const trustedPath = entry.paths[index];
		if (entry.kind === "drop") {
			entry.paths.splice(index, 1);
			if (entry.paths.length === 0) this.deleteCapability(capabilityId);
		}
		return trustedPath;
	}

	revoke(capabilityId: string): void {
		if (validCapabilityId(capabilityId)) this.deleteCapability(capabilityId);
	}

	clear(): void {
		this.capabilities.clear();
		this.currentClipboardCapabilityId = null;
	}

	private createCapability(
		paths: readonly string[],
		kind: CapabilityKind,
		sequence: number | undefined,
		ttlMs: number,
	): string | null {
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
			this.deleteCapability(oldest);
		}
		const capabilityId = randomUUID();
		this.capabilities.set(capabilityId, {
			paths: uniquePaths,
			sequence,
			expiresAt: Date.now() + ttlMs,
			kind,
		});
		if (kind === "clipboard") this.currentClipboardCapabilityId = capabilityId;
		return capabilityId;
	}

	private deleteCapability(capabilityId: string): void {
		this.capabilities.delete(capabilityId);
		if (this.currentClipboardCapabilityId === capabilityId) this.currentClipboardCapabilityId = null;
	}

	private getEntry(capabilityId: string): CapabilityEntry {
		if (!validCapabilityId(capabilityId)) throw new ExternalFileCapabilityError();
		const entry = this.capabilities.get(capabilityId);
		if (!entry || entry.expiresAt <= Date.now()) {
			this.deleteCapability(capabilityId);
			throw new ExternalFileCapabilityError();
		}
		return entry;
	}

	private pruneExpired(): void {
		const now = Date.now();
		for (const [capabilityId, entry] of this.capabilities) {
			if (entry.expiresAt <= now) this.deleteCapability(capabilityId);
		}
	}
}
