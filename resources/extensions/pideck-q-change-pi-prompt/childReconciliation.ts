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

const BUILTIN_OR_INTERNAL_TOOLS = BUILTIN_OR_INTERNAL_CHILD_TOOLS;

export function resolveCurrentChangePiPromptPath(baseDir?: string): string {
	const currentDir = baseDir
		?? (typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url)));
	const candidates = [
		resolve(currentDir, '..', 'pideck-q-change-pi-prompt.ts'),
		resolve(currentDir, '..', '..', 'resources', 'extensions', 'pideck-q-change-pi-prompt.ts'),
		resolve(currentDir, 'pideck-q-change-pi-prompt.ts'),
	];
	for (const cand of candidates) if (existsSync(cand)) return cand;
	return candidates[0];
}

export function resolveLoadableToolProvider(
	toolName: string,
	parentTools: readonly ToolSnapshot[],
): { loadable: boolean; providerPath?: string } {
	if (BUILTIN_OR_INTERNAL_TOOLS.has(toolName)) return { loadable: true };
	const extTool = parentTools.find(t => t.name === toolName);
	if (!extTool) return { loadable: false };
	const path = extTool.sourceInfo?.path;
	if (path && isAbsolute(path) && existsSync(path) && extTool.sourceInfo?.source !== 'builtin') {
		return { loadable: true, providerPath: path };
	}
	return { loadable: false };
}

export function resolveToolProviderExtension(
	toolName: string,
	parentTools: readonly ToolSnapshot[],
	parentActiveTools: readonly string[],
): { available: boolean; providerPath?: string } {
	if (BUILTIN_OR_INTERNAL_TOOLS.has(toolName)) return { available: true };
	if (!parentActiveTools.includes(toolName)) return { available: false };
	const loadable = resolveLoadableToolProvider(toolName, parentTools);
	return loadable.loadable ? { available: true, providerPath: loadable.providerPath } : { available: false };
}

interface ManagedStateFile {
	version: number;
	managedPaths: string[];
}

const SHELL_POLICY_FILE_PREFIX = 'effective-shell-policy';
export const SHELL_POLICY_OWNER_ENV = 'CHANGE_PI_PROMPT_SHELL_POLICY_OWNER';
const SHELL_POLICY_OWNER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHELL_POLICY_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function shellPolicyOwnerToken(ownerKey: string): string {
	if (SHELL_POLICY_OWNER_KEY_PATTERN.test(ownerKey)) return ownerKey;
	return `h-${createHash('sha256').update(ownerKey).digest('hex').slice(0, 32)}`;
}

export function shellPolicySnapshotPath(agentDir: string, ownerKey: string): string {
	return join(agentDir, 'change-pi-prompt', `${SHELL_POLICY_FILE_PREFIX}.${shellPolicyOwnerToken(ownerKey)}.json`);
}

export function resolveShellPolicyOwnerKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env[SHELL_POLICY_OWNER_ENV];
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

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
		if (!isRecord(parsed) || parsed.platform !== platform) return undefined;
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
		// Missing snapshot: child falls back to conservative pruning.
	}
}

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
			} catch {}
		}
	} catch {}
}

function writeJsonAtomic(filePath: string, payload: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp.${Date.now()}.${process.pid}`;
	try {
		writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
		renameSync(tmpPath, filePath);
	} finally {
		try { if (existsSync(tmpPath)) rmSync(tmpPath, { force: true }); } catch {}
	}
}

function readManagedState(statePath: string): string[] {
	if (!existsSync(statePath)) return [];
	try {
		const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
		if (isRecord(parsed) && Array.isArray(parsed.managedPaths)) {
			return parsed.managedPaths.filter((p): p is string => typeof p === 'string');
		}
	} catch {}
	return [];
}

const PWSH_ADAPTER_PACKAGE = '@99percentpeople/pi-pwsh-adapter';

/** Identify an old managed pi-pwsh-adapter provider path for one-time child-settings migration. */
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
		} catch {}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return false;
}

const RECONCILIATION_LOCK_FILE = 'reconciliation.lock';
const RECONCILIATION_LOCK_RETRY_MS = 50;
const RECONCILIATION_LOCK_TIMEOUT_MS = 2_000;
const RECONCILIATION_LOCK_STALE_MS = 30_000;

export interface ReconciliationLockOptions {
	timeoutMs?: number;
	retryMs?: number;
	staleMs?: number;
	wait?: (delayMs: number) => Promise<void>;
	now?: () => number;
}

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
		try { writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: now() })); }
		finally { closeSync(fd); }
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') return false;
	}
	try {
		const raw = JSON.parse(readFileSync(lockPath, 'utf8'));
		const createdAt = isRecord(raw) && typeof raw.createdAt === 'number' ? raw.createdAt : undefined;
		const age = createdAt === undefined ? Number.POSITIVE_INFINITY : now() - createdAt;
		if (age <= staleMs) return false;
		rmSync(lockPath, { force: true });
	} catch {
		try { rmSync(lockPath, { force: true }); }
		catch { return false; }
	}
	return tryTakeLock(lockPath, now, staleMs);
}

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
	try { return await fn(); }
	finally {
		try { rmSync(lockPath, { force: true }); } catch {}
	}
}

export async function reconcileChildEnvironments(options: {
	agentDir: string;
	catalog: SubagentCatalog | undefined;
	parentTools: readonly ToolSnapshot[];
	parentActiveTools: readonly string[];
	platform: NodeJS.Platform;
	shellPolicy: EffectiveShellPolicy;
	shellPolicyOwnerKey?: string;
	changePiPromptPath?: string;
	lock?: ReconciliationLockOptions;
}): Promise<ReconciliationResult | undefined> {
	return withReconciliationLock(
		options.agentDir,
		() => reconcileChildEnvironmentsLocked(options),
		options.lock,
	);
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
	const obsoleteManagedPwshAdapterPaths = new Set([...previousManagedPaths].filter(isPwshAdapterProviderPath));
	const nextManagedPaths = new Set<string>();
	if (changePiPromptPath && existsSync(changePiPromptPath)) nextManagedPaths.add(changePiPromptPath);
	for (const path of previousManagedPaths) if (existsSync(path)) nextManagedPaths.add(path);

	const settingsPath = join(agentDir, 'settings.json');
	let isSymlink = false;
	try { if (existsSync(settingsPath)) isSymlink = lstatSync(settingsPath).isSymbolicLink(); } catch {}
	let settingsObj: Record<string, unknown> = {};
	let canWriteSettings = !isSymlink;
	if (existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
			if (!isRecord(parsed)) canWriteSettings = false;
			else settingsObj = parsed;
		} catch { canWriteSettings = false; }
	}

	let settingsDirty = false;
	let migrationSettingsDirty = false;
	if (canWriteSettings && obsoleteManagedPwshAdapterPaths.size > 0) {
		const subagents = isRecord(settingsObj.subagents) ? settingsObj.subagents : undefined;
		const overrides = subagents && isRecord(subagents.agentOverrides) ? subagents.agentOverrides : undefined;
		if (overrides) {
			for (const override of Object.values(overrides)) {
				if (!isRecord(override) || !Array.isArray(override.subagentOnlyExtensions)) continue;
				const existing = (override.subagentOnlyExtensions as unknown[]).filter((p): p is string => typeof p === 'string');
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
			const missingTools: string[] = [];
			const agentExtensions = new Set<string>();
			if (changePiPromptPath && existsSync(changePiPromptPath)) agentExtensions.add(changePiPromptPath);

			for (const toolName of agent.tools) {
				if (isShellToolName(toolName)) continue;
				const resolution = resolveToolProviderExtension(toolName, parentTools, parentActiveTools);
				if (!resolution.available) missingTools.push(toolName);
				const loadable = resolveLoadableToolProvider(toolName, parentTools);
				if (loadable.providerPath) {
					agentExtensions.add(loadable.providerPath);
					nextManagedPaths.add(loadable.providerPath);
				}
			}

			const shellSlots = resolveChildShellSlots({ platform, policy: shellPolicy, declaredTools: agent.tools });
			if (!shellSlots.available) missingTools.push(...agent.tools.filter(isShellToolName));
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
			if (!canWriteSettings) continue;

			const subagents = isRecord(settingsObj.subagents) ? settingsObj.subagents : undefined;
			const overrides = subagents && isRecord(subagents.agentOverrides) ? subagents.agentOverrides : undefined;
			const agentOverride = overrides && isRecord(overrides[name]) ? overrides[name] : undefined;
			if (agentOverride && agentOverride.subagentOnlyExtensions === false) {
				incompatibleAgents.push(name);
				continue;
			}

			const existingList: string[] = Array.isArray(agentOverride?.subagentOnlyExtensions)
				? (agentOverride!.subagentOnlyExtensions as unknown[]).filter((p): p is string => typeof p === 'string')
				: [];
			const userCustomPaths = existingList.filter(p => !previousManagedPaths.has(p));
			const survivingManagedPaths = existingList.filter(p => {
				if (!previousManagedPaths.has(p) || obsoleteManagedPwshAdapterPaths.has(p)) return false;
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
				(ov[name] as Record<string, unknown>).subagentOnlyExtensions = mergedList;
				settingsDirty = true;
			}
		}
	}

	let settingsWriteSucceeded = !settingsDirty;
	if (canWriteSettings && settingsDirty) {
		try {
			writeJsonAtomic(settingsPath, settingsObj);
			settingsWriteSucceeded = true;
		} catch {}
	}
	if (canWriteSettings && obsoleteManagedPwshAdapterPaths.size > 0
		&& (!migrationSettingsDirty || settingsWriteSucceeded)) {
		for (const path of obsoleteManagedPwshAdapterPaths) nextManagedPaths.delete(path);
	}

	try {
		const stateData: ManagedStateFile = { version: 1, managedPaths: [...nextManagedPaths] };
		writeJsonAtomic(statePath, stateData);
	} catch {}
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
