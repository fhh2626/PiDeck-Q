/**
 * Non-destructive reconciliation of child tool environments in settings.json.
 * Manages subagents.agentOverrides.<agent>.subagentOnlyExtensions for native subagents.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord, type ToolSnapshot } from './contributions.ts';
import { isShellToolName, resolveChildShellSlots, type EffectiveShellPolicy } from './childShellPolicy.ts';
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
			mkdirSync(dirname(settingsPath), { recursive: true });
			const tmpPath = join(agentDir, `settings.json.tmp.${Date.now()}.${process.pid}`);
			writeFileSync(tmpPath, JSON.stringify(settingsObj, null, 2) + '\n', 'utf8');
			renameSync(tmpPath, settingsPath);
		} catch {
			// Fail conservative on write error
		}
	}

	// Persist managed paths state
	try {
		mkdirSync(stateDir, { recursive: true });
		const stateData: ManagedStateFile = {
			version: 1,
			managedPaths: [...currentManagedPaths],
		};
		writeFileSync(statePath, JSON.stringify(stateData, null, 2) + '\n', 'utf8');
	} catch {
		// Ignore state file write errors
	}

	return {
		compatibilityStatus,
		incompatibleAgents,
		managedPaths: [...currentManagedPaths],
		changed: settingsDirty,
	};
}
