import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isRecord } from './toolMetadata.ts';
import { writeJsonAtomic } from './policyStorage.ts';
import type { EffectiveChildPolicy, EffectiveShellPolicy, ShellPolicySnapshot } from './childShellPolicy.ts';

/**
 * Parent-published policy lives in the subagent-owned environment directory.
 * Legacy prompt-owned snapshots remain readable during upgrades.
 *
 * PiDeck runs one pi process per Agent session against a shared agentDir, so a single global file
 * would let two sessions overwrite each other's ceiling and make a child read the other session's
 * shells. Every parent therefore publishes to its own owner-scoped file.
 */
const SHELL_POLICY_FILE_PREFIX = 'effective-shell-policy';
/**
 * Carries the owning parent's key during extension loading. Native child hooks also capture the
 * actual parent session id so concurrent child loading cannot change an existing child's owner.
 */
export const SHELL_POLICY_OWNER_ENV = 'PI_SUBAGENT_POLICY_OWNER';
const LEGACY_SHELL_POLICY_OWNER_ENV = 'CHANGE_PI_PROMPT_SHELL_POLICY_OWNER';
/** Keys are usually session ids (UUIDv7); anything else is hashed so it can never escape the state dir. */
const SHELL_POLICY_OWNER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Owner snapshots are ephemeral; files left behind by long-gone sessions are pruned on write. */
const SHELL_POLICY_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Filesystem-safe token for an owner key; unvalidated keys are hashed instead of used as a path. */
export function shellPolicyOwnerToken(ownerKey: string): string {
	if (SHELL_POLICY_OWNER_KEY_PATTERN.test(ownerKey)) return ownerKey;
	return `h-${createHash('sha256').update(ownerKey).digest('hex').slice(0, 32)}`;
}

/** Path of the parent-owned shell ceiling consumed by that parent's children. */
export function shellPolicySnapshotPath(agentDir: string, ownerKey: string): string {
	return join(agentDir, 'subagents', 'environment', `${SHELL_POLICY_FILE_PREFIX}.${shellPolicyOwnerToken(ownerKey)}.json`);
}

/** Owner key published for child runtimes, or undefined when this runtime has no parent context. */
export function resolveShellPolicyOwnerKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env[SHELL_POLICY_OWNER_ENV] ?? env[LEGACY_SHELL_POLICY_OWNER_ENV];
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read the child policy published by the parent that owns this runtime.
 * Child runtimes only consume it; a missing owner, missing file, or malformed/foreign-platform
 * snapshot is ignored so the caller falls back to conservative pruning.
 * Version 1 snapshots stay readable: they carry the shell ceiling but no extension tool ceiling.
 */
/** Read one owner without widening a corrupt current snapshot to legacy data. */
function readOwnerSnapshot(agentDir: string, platform: NodeJS.Platform, ownerKey: string): EffectiveChildPolicy | undefined {
	const currentPath = shellPolicySnapshotPath(agentDir, ownerKey);
	const file = existsSync(currentPath) ? currentPath
		: join(agentDir, 'change-pi-prompt', `${SHELL_POLICY_FILE_PREFIX}.${shellPolicyOwnerToken(ownerKey)}.json`);
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
		if (!isRecord(parsed) || parsed.platform !== platform) return;
		if (parsed.version === 1 && typeof parsed.bash === 'boolean' && typeof parsed.powershell === 'boolean') {
			return { version: 1, platform, bash: parsed.bash, powershell: parsed.powershell };
		}
		if (parsed.version !== 2 || !isRecord(parsed.shell) || !Array.isArray(parsed.parentActiveTools)) return;
		const { bash, powershell } = parsed.shell;
		if (typeof bash !== 'boolean' || typeof powershell !== 'boolean') return;
		if (parsed.parentOwnerKey !== undefined && (typeof parsed.parentOwnerKey !== 'string' || !parsed.parentOwnerKey.trim())) return;
		return {
			version: 2, platform, shell: { bash, powershell },
			parentActiveTools: parsed.parentActiveTools.filter((name): name is string => typeof name === 'string'),
			...(typeof parsed.parentOwnerKey === 'string' ? { parentOwnerKey: parsed.parentOwnerKey } : {}),
		};
	} catch { return; }
}

/** Every ancestor is checked on each tool call so an active grandchild observes root revocation. */
export function readEffectiveShellPolicySnapshot(
	agentDir: string,
	platform: NodeJS.Platform,
	ownerKey: string | undefined = resolveShellPolicyOwnerKey(),
): EffectiveChildPolicy | undefined {
	if (!ownerKey) return;
	const own = readOwnerSnapshot(agentDir, platform, ownerKey);
	if (!own || own.version !== 2) return own;
	const result: ShellPolicySnapshot = { ...own, shell: { ...own.shell }, parentActiveTools: [...own.parentActiveTools] };
	const visited = new Set([ownerKey]);
	let upstream = own.parentOwnerKey;
	while (upstream) {
		if (visited.has(upstream) || visited.size >= 32) return;
		visited.add(upstream);
		const parent = readOwnerSnapshot(agentDir, platform, upstream);
		if (!parent || parent.version !== 2) return;
		result.parentActiveTools = result.parentActiveTools.filter(name => parent.parentActiveTools.includes(name));
		result.shell.bash &&= parent.shell.bash;
		result.shell.powershell &&= parent.shell.powershell;
		upstream = parent.parentOwnerKey;
	}
	return result;
}

/**
 * A session writes only its own policy. Authorized fanout children link it to their inherited
 * owner and keep the process owner unchanged. Root publication updates the env var only after
 * the atomic write so a concurrent child never sees a half-written policy.
 * `parentActiveTools` must be the parent's final `getActiveTools()` result, never `getAllTools()`.
 */
export function writeEffectiveShellPolicySnapshot(
	stateDir: string,
	platform: NodeJS.Platform,
	policy: EffectiveShellPolicy,
	ownerKey: string,
	parentActiveTools: readonly string[],
	parentOwnerKey?: string,
): boolean {
	try {
		const snapshot: ShellPolicySnapshot = {
			version: 2,
			platform,
			shell: { bash: policy.bash, powershell: policy.powershell },
			parentActiveTools: [...new Set(parentActiveTools)],
			...(parentOwnerKey ? { parentOwnerKey } : {}),
		};
		const snapshotPath = join(stateDir, `${SHELL_POLICY_FILE_PREFIX}.${shellPolicyOwnerToken(ownerKey)}.json`);
		writeJsonAtomic(snapshotPath, snapshot);
		if (!parentOwnerKey) process.env[SHELL_POLICY_OWNER_ENV] = ownerKey;
		pruneStaleShellPolicySnapshots(stateDir, snapshotPath);
		return true;
	} catch {
		return false;
	}
}

/** Remove owner snapshots left behind by sessions that ended long ago; never touch the live one. */
function pruneStaleShellPolicySnapshots(stateDir: string, keepPath: string): void {
	try {
		const keep = basename(keepPath);
		const now = Date.now();
		for (const entry of readdirSync(stateDir)) {
			if (entry === keep) continue;
			if (!entry.startsWith(`${SHELL_POLICY_FILE_PREFIX}.`) || !entry.endsWith('.json')) continue;
			try {
				const filePath = join(stateDir, entry);
				if (now - statSync(filePath).mtimeMs > SHELL_POLICY_SNAPSHOT_TTL_MS) rmSync(filePath, { force: true });
			} catch {
				// Best effort: a file we cannot stat/remove is not worth failing reconciliation over.
			}
		}
	} catch {
		// Best effort cleanup only.
	}
}
