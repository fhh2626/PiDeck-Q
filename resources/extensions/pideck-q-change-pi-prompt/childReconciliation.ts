/**
 * Non-destructive reconciliation of child tool environments in settings.json.
 * Manages subagents.agentOverrides.<agent>.subagentOnlyExtensions for native subagents.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord, type ToolSnapshot } from './contributions.ts';
import {
	BUILTIN_OR_INTERNAL_CHILD_TOOLS,
	isShellToolName,
	resolveChildShellSlots,
	type EffectiveChildPolicy,
	type EffectiveShellPolicy,
	type ShellPolicySnapshot,
} from './childShellPolicy.ts';
import type { SubagentCatalog } from './subagentCatalog.ts';

export interface ChildAgentCompatibility {
	name: string;
	ok: boolean;
	missingTools: string[];
	injectedExtensions: string[];
}

export interface ReconciliationResult {
	compatibilityStatus: Map<string, ChildAgentCompatibility>;
	incompatibleAgents: string[];
	managedPaths: string[];
	changed: boolean;
}

// Builtin and pi-subagents internal tools are resolved by the child runtime itself;
// they must not be judged missing just because the parent session has them inactive.
// The shared list lives in childShellPolicy so the child-side ceiling cannot drift from it.
const BUILTIN_OR_INTERNAL_TOOLS = BUILTIN_OR_INTERNAL_CHILD_TOOLS;

export function resolveCurrentChangePiPromptPath(baseDir?: string): string {
	const currentDir = baseDir
		?? (typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url)));

	const candidates = [
		resolve(currentDir, '..', 'pideck-q-change-pi-prompt.ts'),
		resolve(currentDir, '..', '..', 'resources', 'extensions', 'pideck-q-change-pi-prompt.ts'),
		resolve(currentDir, 'pideck-q-change-pi-prompt.ts'),
	];

	for (const cand of candidates) {
		if (existsSync(cand)) return cand;
	}

	return candidates[0];
}

/**
 * Resolve the provider extension that can supply one non-shell tool, ignoring whether the current
 * parent exposes it. This answers only "can a child load this provider?": the shared settings.json
 * is a provider superset that must survive a session where the tool happens to be inactive.
 * Builtin and pi-subagents internal tools need no provider by design.
 */
export function resolveLoadableToolProvider(
	toolName: string,
	parentTools: readonly ToolSnapshot[],
): { loadable: boolean; providerPath?: string } {
	if (BUILTIN_OR_INTERNAL_TOOLS.has(toolName)) {
		return { loadable: true };
	}

	const extTool = parentTools.find(t => t.name === toolName);
	if (!extTool) {
		return { loadable: false };
	}

	const path = extTool.sourceInfo?.path;
	if (path && isAbsolute(path) && existsSync(path) && extTool.sourceInfo?.source !== 'builtin') {
		return { loadable: true, providerPath: path };
	}

	return { loadable: false };
}

/**
 * Resolve the provider extension a child needs for one non-shell tool, including whether the
 * current parent session actually allows it. Provider availability and tool permission are two
 * separate facts (resolveLoadableToolProvider answers the first), combined here for callers that
 * need the parent's own view.
 */
export function resolveToolProviderExtension(
	toolName: string,
	parentTools: readonly ToolSnapshot[],
	parentActiveTools: readonly string[],
): { available: boolean; providerPath?: string } {
	if (BUILTIN_OR_INTERNAL_TOOLS.has(toolName)) {
		return { available: true };
	}

	if (!parentActiveTools.includes(toolName)) {
		return { available: false };
	}

	const loadable = resolveLoadableToolProvider(toolName, parentTools);
	return loadable.loadable ? { available: true, providerPath: loadable.providerPath } : { available: false };
}

interface ManagedStateFile {
	version: number;
	managedPaths: string[];
}

/**
 * Parent-published shell ceilings live inside the change-pi-prompt state directory.
 *
 * PiDeck runs one pi process per Agent session against a shared agentDir, so a single global file
 * would let two sessions overwrite each other's ceiling and make a child read the other session's
 * shells. Every parent therefore publishes to its own owner-scoped file.
 */
const SHELL_POLICY_FILE_PREFIX = 'effective-shell-policy';
/**
 * Carries the owning parent's key to child runtimes. Foreground native children share the parent
 * process, but detached runner children are separate processes; propagating the key keeps both
 * reading the same scoped snapshot instead of falling back to the wider availability/registry
 * policy the parent already narrowed.
 */
export const SHELL_POLICY_OWNER_ENV = 'CHANGE_PI_PROMPT_SHELL_POLICY_OWNER';
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
	return join(agentDir, 'change-pi-prompt', `${SHELL_POLICY_FILE_PREFIX}.${shellPolicyOwnerToken(ownerKey)}.json`);
}

/** Owner key published for child runtimes, or undefined when this runtime has no parent context. */
export function resolveShellPolicyOwnerKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env[SHELL_POLICY_OWNER_ENV];
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
export function readEffectiveShellPolicySnapshot(
	agentDir: string,
	platform: NodeJS.Platform,
	ownerKey: string | undefined = resolveShellPolicyOwnerKey(),
): EffectiveChildPolicy | undefined {
	if (!ownerKey) return undefined;
	const snapshotPath = shellPolicySnapshotPath(agentDir, ownerKey);
	if (!existsSync(snapshotPath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(snapshotPath, 'utf8'));
		if (!isRecord(parsed)) return undefined;
		if (parsed.platform !== platform) return undefined;
		if (parsed.version === 1) {
			if (typeof parsed.bash !== 'boolean' || typeof parsed.powershell !== 'boolean') return undefined;
			return { version: 1, platform, bash: parsed.bash, powershell: parsed.powershell };
		}
		if (parsed.version === 2) {
			if (!isRecord(parsed.shell)) return undefined;
			const { bash, powershell } = parsed.shell;
			if (typeof bash !== 'boolean' || typeof powershell !== 'boolean') return undefined;
			if (!Array.isArray(parsed.parentActiveTools)) return undefined;
			return {
				version: 2,
				platform,
				shell: { bash, powershell },
				parentActiveTools: parsed.parentActiveTools.filter((name): name is string => typeof name === 'string'),
			};
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Only the parent runtime writes the policy; children never produce shared state.
 * The owner env var is published *after* the atomic write so a concurrent child either sees no
 * owner (conservative fallback) or a complete snapshot, never a half-written file.
 * `parentActiveTools` must be the parent's final `getActiveTools()` result, never `getAllTools()`.
 */
function writeEffectiveShellPolicySnapshot(
	stateDir: string,
	platform: NodeJS.Platform,
	policy: EffectiveShellPolicy,
	ownerKey: string,
	parentActiveTools: readonly string[],
): void {
	try {
		const snapshot: ShellPolicySnapshot = {
			version: 2,
			platform,
			shell: { bash: policy.bash, powershell: policy.powershell },
			parentActiveTools: [...new Set(parentActiveTools)],
		};
		const snapshotPath = join(stateDir, `${SHELL_POLICY_FILE_PREFIX}.${shellPolicyOwnerToken(ownerKey)}.json`);
		writeJsonAtomic(snapshotPath, snapshot);
		process.env[SHELL_POLICY_OWNER_ENV] = ownerKey;
		pruneStaleShellPolicySnapshots(stateDir, snapshotPath);
	} catch {
		// A missing snapshot only widens the child's fallback checks; never fail the reconciliation.
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

/**
 * Temp-file-then-rename JSON write, so a concurrent reader never observes a half-written file.
 * The temp file is always removed: on Windows a failed rename can otherwise leave one locked
 * behind, and a leftover temp file must never be mistaken for a published snapshot.
 */
function writeJsonAtomic(filePath: string, payload: unknown): void {
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

function readManagedState(statePath: string): string[] {
	if (!existsSync(statePath)) return [];
	try {
		const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
		if (isRecord(parsed) && Array.isArray(parsed.managedPaths)) {
			return parsed.managedPaths.filter((p): p is string => typeof p === 'string');
		}
	} catch {
		// Ignore corrupted state file
	}
	return [];
}

const PWSH_ADAPTER_PACKAGE = '@99percentpeople/pi-pwsh-adapter';

/**
 * Old change-pi-prompt versions injected pi-pwsh-adapter into native child extension lists.
 * The adapter owns the same public `bash` name as real Bash, so a shared provider superset can
 * make one session's stale adapter override another session's Bash. Only paths already recorded
 * in our managed-state file are migration candidates; unmanaged user paths remain untouched.
 */
export function isPwshAdapterProviderPath(providerPath: string): boolean {
	const normalized = providerPath.replace(/\\/g, '/');
	if (normalized.includes(`/node_modules/${PWSH_ADAPTER_PACKAGE}/`)) return true;

	let current = dirname(providerPath);
	for (let depth = 0; depth < 8; depth++) {
		try {
			const packageJsonPath = join(current, 'package.json');
			if (existsSync(packageJsonPath)) {
				const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
				if (isRecord(parsed) && parsed.name === PWSH_ADAPTER_PACKAGE) return true;
			}
		} catch {
			// Keep walking: malformed/unreadable package metadata must not break reconciliation.
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return false;
}

/**
 * Cross-process lock guarding reconciliation's read-merge-write of shared files.
 *
 * Atomic rename prevents a torn file, but not a lost update: two parents sharing one agentDir can
 * both read the old settings.json and then each write only its own discovery. Holding this lock
 * around the whole read-merge-write makes the merge span both writers.
 */
const RECONCILIATION_LOCK_FILE = 'reconciliation.lock';
const RECONCILIATION_LOCK_RETRY_MS = 50;
const RECONCILIATION_LOCK_TIMEOUT_MS = 2_000;
/** A lock older than this is presumed abandoned by a crashed runtime and may be reclaimed. */
const RECONCILIATION_LOCK_STALE_MS = 30_000;

export interface ReconciliationLockOptions {
	timeoutMs?: number;
	retryMs?: number;
	staleMs?: number;
	/** Injected for deterministic tests; defaults to a real timer. */
	wait?: (delayMs: number) => Promise<void>;
	/** Injected for deterministic tests; defaults to Date.now. */
	now?: () => number;
}

/** Path of the reconciliation lock inside the shared state directory. */
export function reconciliationLockPath(agentDir: string): string {
	return join(agentDir, 'change-pi-prompt', RECONCILIATION_LOCK_FILE);
}

function defaultLockWait(delayMs: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, delayMs));
}

function tryTakeLock(lockPath: string, now: () => number, staleMs: number): boolean {
	try {
		mkdirSync(dirname(lockPath), { recursive: true });
		const fd = openSync(lockPath, 'wx');
		try {
			writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: now() }));
		} finally {
			closeSync(fd);
		}
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') return false;
	}

	// An abandoned lock (crashed runtime, killed process) must not wedge every later session forever.
	try {
		const raw = JSON.parse(readFileSync(lockPath, 'utf8'));
		const createdAt = isRecord(raw) && typeof raw.createdAt === 'number' ? raw.createdAt : undefined;
		const age = createdAt === undefined ? Number.POSITIVE_INFINITY : now() - createdAt;
		if (age <= staleMs) return false;
		rmSync(lockPath, { force: true });
	} catch {
		// Unreadable lock: treat it as stale rather than waiting on it forever.
		try {
			rmSync(lockPath, { force: true });
		} catch {
			return false;
		}
	}
	return tryTakeLock(lockPath, now, staleMs);
}

/**
 * Run `fn` while holding the reconciliation lock. Returns undefined when the lock could not be
 * acquired within the timeout: the caller then fails conservative and leaves shared files alone.
 */
export async function withReconciliationLock<T>(
	agentDir: string,
	fn: () => T | Promise<T>,
	options: ReconciliationLockOptions = {},
): Promise<T | undefined> {
	const now = options.now ?? Date.now;
	const wait = options.wait ?? defaultLockWait;
	const timeoutMs = options.timeoutMs ?? RECONCILIATION_LOCK_TIMEOUT_MS;
	const retryMs = options.retryMs ?? RECONCILIATION_LOCK_RETRY_MS;
	const staleMs = options.staleMs ?? RECONCILIATION_LOCK_STALE_MS;
	const lockPath = reconciliationLockPath(agentDir);
	const deadline = now() + timeoutMs;

	while (!tryTakeLock(lockPath, now, staleMs)) {
		if (now() >= deadline) return undefined;
		await wait(retryMs);
	}

	try {
		return await fn();
	} finally {
		try {
			rmSync(lockPath, { force: true });
		} catch {
			// A lock we cannot remove is reclaimed by the stale check on the next attempt.
		}
	}
}

/**
 * Reconcile child tool environments against the shared agentDir.
 *
 * The whole read-merge-write runs under the cross-process reconciliation lock, so a parallel
 * session cannot lose this session's provider discoveries. Returns undefined when the lock could
 * not be acquired (fail conservative: shared files stay untouched).
 *
 * Shared settings.json holds the provider *superset*: a provider that is loadable may be added,
 * but an inactive parent session never removes one another session may still need. The real
 * per-session ceiling is published separately to the owner-scoped snapshot.
 */
export async function reconcileChildEnvironments(options: {
	agentDir: string;
	catalog: SubagentCatalog | undefined;
	parentTools: readonly ToolSnapshot[];
	/** Final active tools of the parent session (getActiveTools), never getAllTools. */
	parentActiveTools: readonly string[];
	platform: NodeJS.Platform;
	shellPolicy: EffectiveShellPolicy;
	/** Identity of this parent runtime; scopes the published shell policy to this session/process. */
	shellPolicyOwnerKey?: string;
	changePiPromptPath?: string;
	lock?: ReconciliationLockOptions;
}): Promise<ReconciliationResult | undefined> {
	const locked = await withReconciliationLock(
		options.agentDir,
		// Read settings/state only after the lock is held, so the merge observes the latest writers.
		() => reconcileChildEnvironmentsLocked(options),
		options.lock,
	);
	return locked;
}

function reconcileChildEnvironmentsLocked(options: {
	agentDir: string;
	catalog: SubagentCatalog | undefined;
	parentTools: readonly ToolSnapshot[];
	parentActiveTools: readonly string[];
	platform: NodeJS.Platform;
	shellPolicy: EffectiveShellPolicy;
	shellPolicyOwnerKey?: string;
	changePiPromptPath?: string;
}): ReconciliationResult {
	const { agentDir, catalog, parentTools, parentActiveTools, platform, shellPolicy } = options;
	const changePiPromptPath = options.changePiPromptPath ?? resolveCurrentChangePiPromptPath();
	const compatibilityStatus = new Map<string, ChildAgentCompatibility>();
	const incompatibleAgents: string[] = [];

	const stateDir = join(agentDir, 'change-pi-prompt');
	const statePath = join(stateDir, 'managed-child-extensions.json');
	const previousManagedPaths = new Set(readManagedState(statePath));
	const obsoleteManagedPwshAdapterPaths = new Set(
		[...previousManagedPaths].filter(isPwshAdapterProviderPath),
	);
	/** Managed paths still worth keeping: the union of previous and newly discovered ones. */
	const nextManagedPaths = new Set<string>();
	if (changePiPromptPath && existsSync(changePiPromptPath)) {
		nextManagedPaths.add(changePiPromptPath);
	}
	// A previously managed path survives unless its file is really gone. An inactive tool in this
	// session must never evict a provider another session still loads from the shared superset.
	for (const path of previousManagedPaths) {
		if (existsSync(path)) nextManagedPaths.add(path);
	}

	const settingsPath = join(agentDir, 'settings.json');
	let isSymlink = false;
	try {
		if (existsSync(settingsPath)) {
			const stat = lstatSync(settingsPath);
			isSymlink = stat.isSymbolicLink();
		}
	} catch {
		// Ignore stat error
	}

	let settingsObj: Record<string, unknown> = {};
	let canWriteSettings = !isSymlink;

	if (existsSync(settingsPath)) {
		try {
			const raw = readFileSync(settingsPath, 'utf8');
			const parsed = JSON.parse(raw);
			if (!isRecord(parsed)) {
				canWriteSettings = false;
			} else {
				settingsObj = parsed;
			}
		} catch {
			canWriteSettings = false;
		}
	}

	let settingsDirty = false;
	let migrationSettingsDirty = false;

	// Old versions managed pi-pwsh-adapter as a child provider. Remove only paths that are both
	// in our managed state and identifiable as that package. If settings cannot be safely rewritten,
	// keep managed ownership so a later successful reconciliation can retry instead of treating the
	// stale adapter as user-owned.
	if (canWriteSettings && obsoleteManagedPwshAdapterPaths.size > 0) {
		const subagents = isRecord(settingsObj.subagents) ? settingsObj.subagents : undefined;
		const overrides = subagents && isRecord(subagents.agentOverrides) ? subagents.agentOverrides : undefined;
		if (overrides) {
			for (const override of Object.values(overrides)) {
				if (!isRecord(override) || !Array.isArray(override.subagentOnlyExtensions)) continue;
				const existing = (override.subagentOnlyExtensions as unknown[])
					.filter((p): p is string => typeof p === 'string');
				const filtered = existing.filter(p => !obsoleteManagedPwshAdapterPaths.has(p));
				if (filtered.length !== existing.length) {
					override.subagentOnlyExtensions = filtered;
					settingsDirty = true;
					migrationSettingsDirty = true;
				}
			}
		}
	}

	if (catalog) {
		for (const [name, agent] of catalog.agents.entries()) {
			if (agent.runnerType !== 'native') continue;

			// Check tool compatibility
			const missingTools: string[] = [];
			const agentExtensions = new Set<string>();
			if (changePiPromptPath && existsSync(changePiPromptPath)) {
				agentExtensions.add(changePiPromptPath);
			}

			for (const toolName of agent.tools) {
				// Shell slots are canonicalized separately: a pwsh adapter named bash is not a bash backend.
				if (isShellToolName(toolName)) continue;
				// Two separate questions, deliberately answered separately:
				//  - resolveToolProviderExtension: does this parent allow the tool? (builtin/internal bypass it)
				//  - resolveLoadableToolProvider: can a child load its provider? (the shared superset)
				// Only the second decides the shared settings.json, so an inactive parent never evicts a
				// provider another session still needs.
				const resolution = resolveToolProviderExtension(toolName, parentTools, parentActiveTools);
				if (!resolution.available) {
					missingTools.push(toolName);
				}
				const loadable = resolveLoadableToolProvider(toolName, parentTools);
				if (loadable.providerPath) {
					agentExtensions.add(loadable.providerPath);
					nextManagedPaths.add(loadable.providerPath);
				}
			}

			// Shell: declare the canonical backend set, not the historical tool name.
			const shellSlots = resolveChildShellSlots({ platform, policy: shellPolicy, declaredTools: agent.tools });
			if (!shellSlots.available) {
				missingTools.push(...agent.tools.filter(isShellToolName));
			}
			for (const providerPath of shellSlots.providerPaths) {
				agentExtensions.add(providerPath);
				nextManagedPaths.add(providerPath);
			}

			compatibilityStatus.set(name, {
				name,
				ok: missingTools.length === 0,
				missingTools,
				injectedExtensions: [...agentExtensions],
			});

			// Reconcile settings.json overrides for native agent
			if (!canWriteSettings) continue;

			const subagents = isRecord(settingsObj.subagents) ? settingsObj.subagents : undefined;
			const overrides = subagents && isRecord(subagents.agentOverrides) ? subagents.agentOverrides : undefined;
			const agentOverride = overrides && isRecord(overrides[name]) ? overrides[name] : undefined;

			// Respect explicit user setting of subagentOnlyExtensions: false
			if (agentOverride && agentOverride.subagentOnlyExtensions === false) {
				incompatibleAgents.push(name);
				continue;
			}

			const existingList: string[] = Array.isArray(agentOverride?.subagentOnlyExtensions)
				? (agentOverride!.subagentOnlyExtensions as unknown[]).filter((p): p is string => typeof p === 'string')
				: [];

			// Merge to a provider superset: user paths and still-existing managed paths survive, this
			// session's discoveries are added. Nothing is dropped merely because it is inactive here.
			const userCustomPaths = existingList.filter(p => !previousManagedPaths.has(p));
			const survivingManagedPaths = existingList.filter(p => {
				if (!previousManagedPaths.has(p)) return false;
				if (obsoleteManagedPwshAdapterPaths.has(p)) return false;
				return nextManagedPaths.has(p) || existsSync(p);
			});
			const mergedList = [...new Set([...userCustomPaths, ...survivingManagedPaths, ...agentExtensions])];

			const isSame = existingList.length === mergedList.length
				&& existingList.every((val, idx) => val === mergedList[idx]);

			if (!isSame) {
				if (!isRecord(settingsObj.subagents)) settingsObj.subagents = {};
				const sub = settingsObj.subagents as Record<string, unknown>;
				if (!isRecord(sub.agentOverrides)) sub.agentOverrides = {};
				const ov = sub.agentOverrides as Record<string, unknown>;
				if (!isRecord(ov[name])) ov[name] = {};
				const target = ov[name] as Record<string, unknown>;
				target.subagentOnlyExtensions = mergedList;
				settingsDirty = true;
			}
		}
	}

	let settingsWriteSucceeded = !settingsDirty;
	if (canWriteSettings && settingsDirty) {
		try {
			writeJsonAtomic(settingsPath, settingsObj);
			settingsWriteSucceeded = true;
		} catch {
			// Fail conservative on write error; managed ownership stays for a later retry.
		}
	}

	// Drop obsolete adapter ownership only after its settings migration no longer needs a write,
	// or after that write actually succeeded. Otherwise a failed migration could make the next run
	// misclassify a stale on-disk adapter as a user-owned path and preserve it forever.
	if (canWriteSettings && obsoleteManagedPwshAdapterPaths.size > 0
		&& (!migrationSettingsDirty || settingsWriteSucceeded)) {
		for (const path of obsoleteManagedPwshAdapterPaths) nextManagedPaths.delete(path);
	}

	// Persist managed paths state: the superset, not just what this session used.
	try {
		const stateData: ManagedStateFile = {
			version: 1,
			managedPaths: [...nextManagedPaths],
		};
		writeJsonAtomic(statePath, stateData);
	} catch {
		// Ignore state file write errors
	}

	// Publish this parent's final child policy for its own children (see readEffectiveShellPolicySnapshot).
	// The owner key scopes the snapshot so parallel sessions sharing one agentDir never overwrite it.
	writeEffectiveShellPolicySnapshot(
		stateDir,
		platform,
		shellPolicy,
		options.shellPolicyOwnerKey ?? `pid-${process.pid}`,
		parentActiveTools,
	);

	return {
		compatibilityStatus,
		incompatibleAgents,
		managedPaths: [...nextManagedPaths],
		changed: settingsDirty,
	};
}
