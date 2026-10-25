import type { AvailableModel } from "./types/agent";

/** Pi implementation selected by PiDeck. */
export type PiRuntimeKind = "typescript" | "rust" | "bolt" | "unknown";

/** User preference for selecting an installed Pi implementation. */
export type PiRuntimePreference = "auto" | "typescript" | "rust" | "bolt";

/**
 * Environment variable PiDeck sets on a Pi process that is a self-contained
 * binary (no Node + CLI script pair). Built-in extensions read it instead of
 * guessing from the executable name, which differs per distribution
 * (`pi`, `pi-bolt`, a macOS launcher that execs `pi-bin`, a renamed copy, ...).
 */
export const PIDECK_PI_STANDALONE_ENV = "PIDECK_PI_STANDALONE";

/** Whether a runtime ships as a standalone binary (and so cannot be re-launched via Node). */
export function isStandaloneRuntimeKind(kind: PiRuntimeKind): boolean {
	return kind === "bolt";
}

/**
 * Classify `pi --version` output.
 * - Rust Pi prefixes its version with `pi`.
 * - Pi-Bolt prints the upstream Pi semver followed by a `(Pi-Bolt <ver>, ...)`
 *   banner, e.g. `1.4.0 (Pi-Bolt 1.0.2, win32-x64-jit, JIT on)`. The leading
 *   semver is the Pi release it is built on, so the banner is the only reliable
 *   marker and must be checked before the generic semver rule.
 * - The stock TypeScript CLI prints a bare semver.
 * Keep this deliberately conservative: an unrecognised version must remain
 * usable in auto mode instead of being misclassified.
 */
export function detectPiRuntimeKind(version: string): PiRuntimeKind {
	const value = typeof version === "string" ? version.trim() : "";
	if (/^pi\s+v?\d+\.\d+\.\d+\b/i.test(value)) return "rust";
	if (/^v?\d+\.\d+\.\d+\b.*\(\s*Pi-Bolt\b/i.test(value)) return "bolt";
	if (/^v?\d+\.\d+\.\d+\b/.test(value)) return "typescript";
	return "unknown";
}

/**
 * `--approve` / `--no-approve` exist from Pi 0.79.0 and in every 1.x release.
 * Rust Pi has no trust system, and an unparsable version is treated as
 * unsupported so we never pass an unknown option that would stop the process.
 * The version numbers compared here are the upstream Pi's, which Pi-Bolt reports first.
 */
export function piSupportsTrustFlags(version: string): boolean {
	const value = typeof version === "string" ? version.trim() : "";
	if (detectPiRuntimeKind(value) === "rust") return false;
	const match = value.match(/^v?(\d+)\.(\d+)/);
	if (!match) return false;
	const major = parseInt(match[1], 10);
	const minor = parseInt(match[2], 10);
	return major > 0 || minor >= 79;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Convert either Pi implementation's RPC model payload to PiDeck's narrow
 * model contract. The Rust payload calls image capabilities `input`, while
 * older Pi payloads may expose `images` directly.
 */
export function normalizePiRpcModels(data: unknown): AvailableModel[] {
	const container = asRecord(data);
	if (!container || !Array.isArray(container.models)) return [];

	const models: AvailableModel[] = [];
	const seen = new Set<string>();
	for (const item of container.models) {
		const raw = asRecord(item);
		if (!raw) continue;
		const provider = stringValue(raw.provider);
		const id = stringValue(raw.id ?? raw.modelId);
		if (!provider || !id) continue;

		const key = `${provider}\u0000${id}`.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);

		const input = Array.isArray(raw.input) ? raw.input : [];
		const images = typeof raw.images === "boolean"
			? raw.images
			: input.some((value) => value === "image");
		const hasImageCapability = typeof raw.images === "boolean" || input.length > 0;
		const model: AvailableModel = {
			provider,
			id,
			name: stringValue(raw.name) ?? `${provider}/${id}`,
			contextWindow: positiveNumber(raw.contextWindow),
			maxTokens: positiveNumber(raw.maxTokens),
			reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : undefined,
			images: hasImageCapability ? images : undefined,
		};
		models.push(model);
	}
	return models;
}

/** Extract parent-session references emitted by either Pi implementation. */
export function getPiSessionParent(entry: unknown): string | undefined {
	const record = asRecord(entry);
	if (!record || record.type !== "session") return undefined;
	const header = asRecord(record.header);
	const candidates = [
		record.parentSession,
		record.branchedFrom,
		record.parent_session,
		header?.parentSession,
		header?.branchedFrom,
		header?.parent_session,
	];
	return candidates.map(stringValue).find((value): value is string => Boolean(value));
}
