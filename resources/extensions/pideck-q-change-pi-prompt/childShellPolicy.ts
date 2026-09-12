/**
 * Canonical tool policy for native child environments.
 *
 * Registered tools (`getAllTools`) are not the same fact as the parent's final active tools
 * (`getActiveTools`): a shell already pruned from the parent session, or a pwsh adapter that
 * only *claims* the `bash` tool name, must never leak into a child as a fake `bash` slot.
 * Children therefore receive a canonicalized shell set — a real bash backend stays `bash`,
 * PowerShell stays `powershell` — decided by the real backend, the parent's final active
 * shell tools, and the child's own tool list.
 *
 * The same parent/child split decides extension-provided tools: the shared settings.json only
 * guarantees which providers a child *can* load (a superset), while the owner-scoped snapshot
 * carries the ceiling of what this parent actually allows (see reconcileChildExtensionTools).
 */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isChildPowerShellBridge, isPwsh, type ToolSnapshot } from './contributions.ts';
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
	/** Canonical shell set the child ends up with. */
	bash: boolean;
	powershell: boolean;
	/** false when a declared shell slot cannot be satisfied in the child (fail closed). */
	available: boolean;
	/** Extension paths the child needs injected to expose the canonical shell set. */
	providerPaths: string[];
}

export function isShellToolName(name: string): boolean {
	return name === 'bash' || name === 'powershell';
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
 * the pwsh adapter exposes `bash` while running PowerShell.
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

	// The pwsh adapter is a Windows-only adapter for a `bash` slot backed by PowerShell;
	// it must never make the child's canonical `bash` slot active. Treat it as evidence that the
	// parent authorizes PowerShell, but do NOT inject the adapter itself into child settings: it
	// squats on the same `bash` name as real Bash and a shared provider superset could otherwise
	// override Bash in children owned by another session. Child PowerShell is supplied by our bridge.
	const adapterOccupiesBash = platform === 'win32' && !!bashTool && isPwsh(bashTool);
	const adapterProvidesPowerShell = adapterOccupiesBash && active.has('bash') && availability.powershell;
	const bash = availability.bash && active.has('bash') && !adapterOccupiesBash;

	// Native/custom `powershell` providers are safe to inject because they do not collide with the
	// historical `bash` slot. An active pwsh adapter contributes capability only, not a provider path.
	const nativePowerShellProviderPath = injectableProviderPath(powerShellTool);
	const nativePowerShellLoadable = isBuiltinTool(powerShellTool) || !!nativePowerShellProviderPath;
	const nativePowerShell = availability.powershell && active.has('powershell') && nativePowerShellLoadable;
	const powershell = adapterProvidesPowerShell || nativePowerShell;
	const powershellProviderPath = nativePowerShell ? nativePowerShellProviderPath : undefined;

	return {
		bash,
		powershell,
		bashProviderPath: bash ? injectableProviderPath(bashTool) : undefined,
		powershellProviderPath,
	};
}

/**
 * Map an agent's declared shell slots onto the canonical shell set.
 *
 * Windows replaces the historical `bash` slot with the real backend set, so a shell-capable
 * agent that declares `bash` receives `powershell` when PowerShell is the only real backend.
 * Linux/macOS keep real availability only and never rewrite bash into powershell.
 */
export function resolveChildShellSlots(options: {
	platform: NodeJS.Platform;
	policy: EffectiveShellPolicy;
	declaredTools: readonly string[];
}): ChildShellSlots {
	const { platform, policy, declaredTools } = options;
	const declaredBash = declaredTools.includes('bash');
	const declaredPowerShell = declaredTools.includes('powershell');

	// No shell requirement in the agent definition: never widen it.
	if (!declaredBash && !declaredPowerShell) {
		return { bash: false, powershell: false, available: true, providerPaths: [] };
	}

	if (platform === 'win32') {
		const providerPaths = [policy.bashProviderPath, policy.powershellProviderPath]
			.filter((path): path is string => typeof path === 'string');
		return {
			bash: policy.bash,
			powershell: policy.powershell,
			available: policy.bash || policy.powershell,
			providerPaths,
		};
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
 * allowlist stays authoritative. Windows shell replacement is the one exception and lives in
 * `reconcileChildActiveShellTools`.
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
 * Canonicalize the *final* active shell tools of a running child session.
 *
 * The child knows its own registry and its own active list, so the same mapping rule can be
 * re-applied after the child starts. `wantsShell` must come from the agent definition (the
 * child's own list may already be pruned). `pruneOnly` is used when the child identity cannot
 * be resolved: prune unavailable shells, but never broaden the child's tool set.
 *
 * `ceiling` is the parent's published final shell set. It is authoritative: a shell the parent
 * did not expose must not come back just because the local host still has that backend.
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
	const { platform, availability, registeredTools, activeTools, wantsShell, pruneOnly, ceiling } = options;
	const next = new Set(activeTools);
	const bashTool = registeredTools.find(candidate => candidate.name === 'bash');
	const powerShellTool = registeredTools.find(candidate => candidate.name === 'powershell');
	const powerShellBackedBash = platform === 'win32'
		&& (isChildPowerShellBridge(bashTool) || (!!bashTool && isPwsh(bashTool)));

	// A normal slot is usable only when its own backend exists and the parent exposed it. A
	// PowerShell-backed `bash` compatibility slot is only needed when the child hard allowlist did
	// not register the canonical `powershell` name. If the real `powershell` slot exists, prefer it
	// and never expose the same backend twice under both names.
	const permitted = (name: 'bash' | 'powershell'): boolean => {
		if (name === 'bash' && powerShellBackedBash) {
			if (powerShellTool) return false;
			if (!availability.powershell) return false;
			if (ceiling && ceiling.powershell === false) return false;
			return true;
		}
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
		// A known agent definition with no shell declaration is a hard capability ceiling. Even if
		// an ambient/stale provider somehow makes a shell visible, do not let it survive canonicalization.
		next.delete('bash');
		next.delete('powershell');
		return [...next];
	}

	if (platform === 'win32') {
		if (permitted('bash')) next.add('bash');
		else next.delete('bash');

		if (permitted('powershell')) next.add('powershell');
		else next.delete('powershell');
		return [...next];
	}

	// Linux/macOS: prune to real availability; never rewrite bash into powershell.
	return prune();
}
