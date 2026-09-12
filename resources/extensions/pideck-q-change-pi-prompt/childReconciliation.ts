/**
 * Non-destructive reconciliation of child tool environments in settings.json.
 * Manages subagents.agentOverrides.<agent>.subagentOnlyExtensions for native subagents.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord, type ToolSnapshot } from './contributions.ts';
import {
	isShellToolName,
	resolveChildShellSlots,
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

// Builtins and pi-subagents child internals are resolved by the child runtime itself;
// they must not be judged missing just because the parent session has them inactive.
// Shell tools are deliberately absent here: they follow the canonical shell policy.
const BUILTIN_OR_INTERNAL_TOOLS = new Set([
	'read', 'write', 'edit', 'grep', 'find', 'ls',
	'subagent', 'contact_supervisor', 'structured_output', 'bg_wait', 'subagent_supervisor',
]);

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
 * Resolve the provider extension a child needs for one non-shell tool.
 * Active tools are the authoritative truth: a tool the parent already hid must not be handed
 * to a child. Builtin and pi-subagents internal tools bypass that check by design.
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

	// Extension-provided tool
	const extTool = parentTools.find(t => t.name === toolName);
	if (!extTool) {
		return { available: false };
	}

	const path = extTool.sourceInfo?.path;
	if (path && isAbsolute(path) && existsSync(path) && extTool.sourceInfo?.source !== 'builtin') {
		return { available: true, providerPath: path };
	}

	return { available: false };
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
 * Read the shell ceiling published by the parent that owns this runtime.
 * Child runtimes only consume it; a missing owner, missing file, or malformed/foreign-platform
 * snapshot is ignored so the caller falls back to conservative availability-only pruning.
 */
export function readEffectiveShellPolicySnapshot(
	agentDir: string,
	platform: NodeJS.Platform,
	ownerKey: string | undefined = resolveShellPolicyOwnerKey(),
): ShellPolicySnapshot | undefined {
	if (!ownerKey) return undefined;
	const snapshotPath = shellPolicySnapshotPath(agentDir, ownerKey);
	if (!existsSync(snapshotPath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(snapshotPath, 'utf8'));
		if (!isRecord(parsed)) return undefined;
		if (parsed.version !== 1) return undefined;
		if (parsed.platform !== platform) return undefined;
		if (typeof parsed.bash !== 'boolean' || typeof parsed.powershell !== 'boolean') return undefined;
		return { version: 1, platform, bash: parsed.bash, powershell: parsed.powershell };
	} catch {
		return undefined;
	}
}

/**
 * Only the parent runtime writes the ceiling; children never produce shared state.
 * The owner env var is published *after* the atomic write so a concurrent child either sees no
 * owner (conservative fallback) or a complete snapshot, never a half-written file.
 */
function writeEffectiveShellPolicySnapshot(
	stateDir: string,
	platform: NodeJS.Platform,
	policy: EffectiveShellPolicy,
	ownerKey: string,
): void {
	try {
		const snapshot: ShellPolicySnapshot = {
			version: 1,
			platform,
			bash: policy.bash,
			powershell: policy.powershell,
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

/** Temp-file-then-rename JSON write, so a concurrent reader never observes a half-written file. */
function writeJsonAtomic(filePath: string, payload: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp.${Date.now()}.${process.pid}`;
	writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
	renameSync(tmpPath, filePath);
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

export function reconcileChildEnvironments(options: {
	agentDir: string;
	catalog: SubagentCatalog | undefined;
	parentTools: readonly ToolSnapshot[];
	/** Final active tools of the parent session (getActiveTools), never getAllTools. */
	parentActiveTools: readonly string[];
	platform: NodeJS.Platform;
	shellPolicy: EffectiveShellPolicy;
	/** Identity of this parent runtime; scopes the published shell ceiling to this session/process. */
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
	const currentManagedPaths = new Set<string>();
	if (changePiPromptPath && existsSync(changePiPromptPath)) {
		currentManagedPaths.add(changePiPromptPath);
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
				const resolution = resolveToolProviderExtension(toolName, parentTools, parentActiveTools);
				if (!resolution.available) {
					missingTools.push(toolName);
				} else if (resolution.providerPath) {
					agentExtensions.add(resolution.providerPath);
					currentManagedPaths.add(resolution.providerPath);
				}
			}

			// Shell: declare the canonical backend set, not the historical tool name.
			const shellSlots = resolveChildShellSlots({ platform, policy: shellPolicy, declaredTools: agent.tools });
			if (!shellSlots.available) {
				missingTools.push(...agent.tools.filter(isShellToolName));
			}
			for (const providerPath of shellSlots.providerPaths) {
				agentExtensions.add(providerPath);
				currentManagedPaths.add(providerPath);
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

			// Prune previous managed paths that are no longer needed or stale
			const userCustomPaths = existingList.filter(p => !previousManagedPaths.has(p));
			const mergedList = [...new Set([...userCustomPaths, ...agentExtensions])];

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

	if (canWriteSettings && settingsDirty) {
		try {
			writeJsonAtomic(settingsPath, settingsObj);
		} catch {
			// Fail conservative on write error
		}
	}

	// Persist managed paths state
	try {
		const stateData: ManagedStateFile = {
			version: 1,
			managedPaths: [...currentManagedPaths],
		};
		writeJsonAtomic(statePath, stateData);
	} catch {
		// Ignore state file write errors
	}

	// Publish the parent's final shell ceiling for child runtimes (see readEffectiveShellPolicySnapshot).
	// The owner key scopes the snapshot so parallel sessions sharing one agentDir never overwrite it.
	writeEffectiveShellPolicySnapshot(stateDir, platform, shellPolicy, options.shellPolicyOwnerKey ?? `pid-${process.pid}`);

	return {
		compatibilityStatus,
		incompatibleAgents,
		managedPaths: [...currentManagedPaths],
		changed: settingsDirty,
	};
}
