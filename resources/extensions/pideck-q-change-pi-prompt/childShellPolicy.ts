/**
 * Child tool policy: prune only. Never invent a shell name the child did not already have.
 *
 * Registered tools (`getAllTools`) are not the same fact as the parent's final active tools
 * (`getActiveTools`). A shell the parent already hid, or a pwsh adapter that only *claims*
 * the `bash` name, must not leak into a child as a real bash slot. Child allowlists stay
 * authoritative: this module hides unavailable/unauthorized shells and never rewrites `bash`
 * into `powershell`.
 *
 * The same parent/child split decides extension-provided tools: the shared settings.json only
 * guarantees which providers a child *can* load (a superset), while the owner-scoped snapshot
 * carries the ceiling of what this parent actually allows (see reconcileChildExtensionTools).
 */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isPwsh, type ToolSnapshot } from './contributions.ts';
import type { ShellAvailability } from './shellAvailability.ts';

/**
 * Builtins and pi-subagents child internals are resolved by the child runtime itself;
 * they must not be judged missing just because the parent session has them inactive, and the
 * parent's extension-tool ceiling must never prune them. Shell tools are deliberately absent:
 * they follow the canonical shell policy instead.
 */
export const BUILTIN_OR_INTERNAL_CHILD_TOOLS = new Set([
	'read', 'write', 'edit', 'grep', 'find', 'ls',
	'subagent', 'contact_supervisor', 'structured_output', 'bg_wait', 'subagent_supervisor',
]);

/** Builtin or pi-subagents internal tool that no parent-side ceiling may revoke. */
export function isBuiltinOrInternalChildTool(
	name: string,
	registeredTools: readonly ToolSnapshot[] = [],
): boolean {
	if (BUILTIN_OR_INTERNAL_CHILD_TOOLS.has(name)) return true;
	// A tool the registry reports as builtin is runtime-provided even when it is not on the list above.
	return registeredTools.some(tool => tool.name === name && tool.sourceInfo?.source === 'builtin');
}

export interface EffectiveShellPolicy {
	bash: boolean;
	powershell: boolean;
	bashProviderPath?: string;
	powershellProviderPath?: string;
}

/**
 * The parent's final child policy, published for child runtimes.
 * A child session's tool allowlist comes from the agent definition only, so the child cannot
 * observe the parent's active tools on its own; the parent publishes, the child consumes.
 * Because several sessions share one agentDir, the snapshot is scoped to the owning parent runtime
 * (see readEffectiveShellPolicySnapshot) rather than being a single global file.
 *
 * Version 2 carries both ceilings: the canonical shell backend set and the parent's final active
 * tools, which gate extension-provided child tools (provider availability != tool permission).
 */
export interface ShellPolicySnapshot {
	version: 2;
	platform: string;
	shell: {
		bash: boolean;
		powershell: boolean;
	};
	parentActiveTools: string[];
}

/** Version 1 snapshot published by an older parent: shell ceiling only, no extension tool ceiling. */
export interface LegacyShellPolicySnapshot {
	version: 1;
	platform: string;
	bash: boolean;
	powershell: boolean;
}

/** Any snapshot a child may read; version 1 stays readable so an old parent never breaks a new child. */
export type EffectiveChildPolicy = ShellPolicySnapshot | LegacyShellPolicySnapshot;

export interface ChildShellSlots {
	/** Declared shell names that this parent can actually provide. */
	bash: boolean;
	powershell: boolean;
	/** false when a declared shell slot has no matching parent backend. */
	available: boolean;
	/** Extension paths needed to load a declared, parent-authorized shell provider. */
	providerPaths: string[];
}

export function isShellToolName(name: string): boolean {
	return name === 'bash' || name === 'powershell';
}

export function sameToolList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((name, index) => name === b[index]);
}

/**
 * Rewrite a shell-capable agent's declared tools to the host's real backends.
 * Agents that never declared a shell are returned unchanged.
 * Host availability, not the current session's active tools, decides the names:
 * this list is written to shared settings and must not follow one parent tab.
 */
export function mapDeclaredToolsToHostShells(
	declaredTools: readonly string[],
	hostShells: { bash: boolean; powershell: boolean },
): string[] {
	const declaredBash = declaredTools.includes('bash');
	const declaredPowerShell = declaredTools.includes('powershell');
	if (!declaredBash && !declaredPowerShell) return [...declaredTools];

	const nextShells: string[] = [];
	if (hostShells.bash) nextShells.push('bash');
	if (hostShells.powershell) nextShells.push('powershell');

	const result: string[] = [];
	let inserted = false;
	for (const name of declaredTools) {
		if (!isShellToolName(name)) {
			result.push(name);
			continue;
		}
		if (!inserted) {
			result.push(...nextShells);
			inserted = true;
		}
	}
	if (!inserted) result.push(...nextShells);
	return result;
}

/** Narrow an already-validated snapshot to the shell ceiling shape used by the child mapping. */
export function toShellCeiling(snapshot: EffectiveChildPolicy | undefined): { bash: boolean; powershell: boolean } | undefined {
	if (!snapshot) return undefined;
	// Version 1 keeps its historical top-level shape; version 2 nests the ceiling under `shell`.
	return snapshot.version === 2
		? { bash: snapshot.shell.bash, powershell: snapshot.shell.powershell }
		: { bash: snapshot.bash, powershell: snapshot.powershell };
}

/**
 * The parent's final active tools from a version 2 snapshot.
 * Undefined for a version 1 snapshot: without an explicit extension tool ceiling the child must
 * keep the old behavior instead of guessing a ceiling from a snapshot that never carried one.
 */
export function toParentActiveTools(snapshot: EffectiveChildPolicy | undefined): string[] | undefined {
	return snapshot && snapshot.version === 2 ? [...snapshot.parentActiveTools] : undefined;
}

/**
 * Active agent identity of a child session, read from the `<active_agent name="...">` marker.
 * The child's own active tools cannot be used to infer shell capability: they may already be pruned.
 */
export function getActiveAgentName(systemPrompt: string): string | undefined {
	const match = /<active_agent\s+name=["']([^"']+)["']\s*\/?>/i.exec(systemPrompt);
	return match ? match[1] : undefined;
}

function isBuiltinTool(tool: ToolSnapshot | undefined): boolean {
	return !!tool && tool.sourceInfo?.source === 'builtin';
}

/** A child runtime can only load an extension-provided tool from a real absolute file path. */
function injectableProviderPath(tool: ToolSnapshot | undefined): string | undefined {
	if (!tool || isBuiltinTool(tool)) return undefined;
	const path = tool.sourceInfo?.path;
	if (path && isAbsolute(path) && existsSync(path)) return path;
	return undefined;
}

/**
 * Decide the parent's real shell backends. A tool name alone never establishes a backend:
 * the pwsh adapter exposes `bash` while running PowerShell, and that is not a bash backend.
 */
export function resolveEffectiveShellPolicy(options: {
	platform: NodeJS.Platform;
	availability: ShellAvailability;
	parentTools: readonly ToolSnapshot[];
	parentActiveTools: readonly string[];
}): EffectiveShellPolicy {
	const { platform, availability, parentTools, parentActiveTools } = options;
	const active = new Set(parentActiveTools);
	const bashTool = parentTools.find(tool => tool.name === 'bash');
	const powerShellTool = parentTools.find(tool => tool.name === 'powershell');

	// The adapter squats on `bash`. It must not make the child's bash slot look real, and it is
	// never injected into shared child settings (that would override another session's real Bash).
	const adapterOccupiesBash = platform === 'win32' && !!bashTool && isPwsh(bashTool);
	const bash = availability.bash && active.has('bash') && !adapterOccupiesBash;

	const nativePowerShellProviderPath = injectableProviderPath(powerShellTool);
	const nativePowerShellLoadable = isBuiltinTool(powerShellTool) || !!nativePowerShellProviderPath;
	const powershell = availability.powershell && active.has('powershell') && nativePowerShellLoadable;

	return {
		bash,
		powershell,
		bashProviderPath: bash ? injectableProviderPath(bashTool) : undefined,
		powershellProviderPath: powershell ? nativePowerShellProviderPath : undefined,
	};
}

/**
 * Keep only the shell names the agent actually declared and this parent can provide.
 * Never rewrite `bash` into `powershell`; child allowlists stay authoritative.
 */
export function resolveChildShellSlots(options: {
	platform: NodeJS.Platform;
	policy: EffectiveShellPolicy;
	declaredTools: readonly string[];
}): ChildShellSlots {
	const { policy, declaredTools } = options;
	const declaredBash = declaredTools.includes('bash');
	const declaredPowerShell = declaredTools.includes('powershell');

	if (!declaredBash && !declaredPowerShell) {
		return { bash: false, powershell: false, available: true, providerPaths: [] };
	}

	const providerPaths: string[] = [];
	let available = true;
	if (declaredBash) {
		if (!policy.bash) available = false;
		else if (policy.bashProviderPath) providerPaths.push(policy.bashProviderPath);
	}
	if (declaredPowerShell) {
		if (!policy.powershell) available = false;
		else if (policy.powershellProviderPath) providerPaths.push(policy.powershellProviderPath);
	}
	return {
		bash: declaredBash && policy.bash,
		powershell: declaredPowerShell && policy.powershell,
		available,
		providerPaths,
	};
}

/**
 * Prune extension-provided child tools that the owning parent does not expose.
 *
 * The shared settings.json is a provider *superset*: any session may have registered a tool's
 * provider there. Permission is a separate question answered by the owner-scoped snapshot, so a
 * child keeps only the extension tools this parent actually allows.
 *
 * Deliberately prune-only: a plain extension tool is never added here, because the child's own
 * allowlist stays authoritative. Host-shell names are rewritten only in shared `agentOverrides.tools`.
 *
 * `parentActiveTools` undefined means no version 2 snapshot was available (an older parent, or a
 * missing file); the child then keeps its own list rather than guessing a ceiling.
 */
export function reconcileChildExtensionTools(options: {
	registeredTools: readonly ToolSnapshot[];
	activeTools: readonly string[];
	parentActiveTools: readonly string[] | undefined;
}): string[] {
	const { registeredTools, activeTools, parentActiveTools } = options;
	if (!parentActiveTools) return [...activeTools];
	const allowed = new Set(parentActiveTools);
	return activeTools.filter(name => {
		if (allowed.has(name)) return true;
		// Builtin and pi-subagents internal tools are provided by the child runtime, never by a parent provider.
		if (isBuiltinOrInternalChildTool(name, registeredTools)) return true;
		// Plain extension tool: prune it, but never prune a tool the registry does not know about.
		return !registeredTools.some(tool => tool.name === name);
	});
}

/**
 * Prune the *final* active shell tools of a running child session.
 *
 * `wantsShell` must come from the agent definition (the child's own list may already be pruned).
 * `pruneOnly` is used when the child identity cannot be resolved: hide unavailable shells, but
 * never strip a declared shell that is still permitted, and never add a name.
 *
 * `ceiling` is the parent's published final shell set. A shell the parent did not expose must
 * not come back just because the local host still has that backend.
 */
export function reconcileChildActiveShellTools(options: {
	platform: NodeJS.Platform;
	availability: ShellAvailability;
	registeredTools: readonly ToolSnapshot[];
	activeTools: readonly string[];
	wantsShell: boolean;
	pruneOnly?: boolean;
	ceiling?: { bash: boolean; powershell: boolean };
}): string[] {
	const { availability, registeredTools, activeTools, wantsShell, pruneOnly, ceiling } = options;
	const next = new Set(activeTools);

	const permitted = (name: 'bash' | 'powershell'): boolean => {
		if (!availability[name]) return false;
		if (ceiling && ceiling[name] === false) return false;
		const tool = registeredTools.find(candidate => candidate.name === name);
		if (!tool) return false;
		return !(name === 'bash' && isPwsh(tool));
	};

	const prune = (): string[] => {
		if (!permitted('bash')) next.delete('bash');
		if (!permitted('powershell')) next.delete('powershell');
		return [...next];
	};

	if (pruneOnly) return prune();
	if (!wantsShell) {
		// A known agent definition with no shell declaration is a hard capability ceiling.
		next.delete('bash');
		next.delete('powershell');
		return [...next];
	}

	// Never add a shell name the child did not already have. Child allowlists stay authoritative.
	return prune();
}
