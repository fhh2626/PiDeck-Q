/**
 * Canonical shell policy for native child environments.
 *
 * Registered tools (`getAllTools`) are not the same fact as the parent's final active tools
 * (`getActiveTools`): a shell already pruned from the parent session, or a pwsh adapter that
 * only *claims* the `bash` tool name, must never leak into a child as a fake `bash` slot.
 * Children therefore receive a canonicalized shell set — a real bash backend stays `bash`,
 * PowerShell stays `powershell` — decided by the real backend, the parent's final active
 * shell tools, and the child's own tool list.
 */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isPwsh, type ToolSnapshot } from './contributions.ts';
import type { ShellAvailability } from './shellAvailability.ts';

export interface EffectiveShellPolicy {
	bash: boolean;
	powershell: boolean;
	bashProviderPath?: string;
	powershellProviderPath?: string;
}

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
	// it must never make the child's canonical `bash` slot active.
	const adapterOccupiesBash = platform === 'win32' && !!bashTool && isPwsh(bashTool);
	const bash = availability.bash && active.has('bash') && !adapterOccupiesBash;

	// Only claim powershell when the child can really load it: builtin, or an injectable provider.
	const powerShellProviderPath = injectableProviderPath(powerShellTool);
	const powerShellLoadable = isBuiltinTool(powerShellTool) || !!powerShellProviderPath;
	const powershell = availability.powershell && active.has('powershell') && powerShellLoadable;

	return {
		bash,
		powershell,
		bashProviderPath: bash ? injectableProviderPath(bashTool) : undefined,
		powershellProviderPath: powershell ? powerShellProviderPath : undefined,
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
 * Canonicalize the *final* active shell tools of a running child session.
 *
 * The child knows its own registry and its own active list, so the same mapping rule can be
 * re-applied after the child starts. `wantsShell` must come from the agent definition (the
 * child's own list may already be pruned). `pruneOnly` is used when the child identity cannot
 * be resolved: prune unavailable shells, but never broaden the child's tool set.
 */
export function reconcileChildActiveShellTools(options: {
	platform: NodeJS.Platform;
	availability: ShellAvailability;
	registeredTools: readonly string[];
	activeTools: readonly string[];
	wantsShell: boolean;
	pruneOnly?: boolean;
}): string[] {
	const { platform, availability, registeredTools, activeTools, wantsShell, pruneOnly } = options;
	const next = new Set(activeTools);

	const prune = (): string[] => {
		if (!availability.bash) next.delete('bash');
		if (!availability.powershell) next.delete('powershell');
		return [...next];
	};

	if (pruneOnly) return prune();
	if (!wantsShell) return [...next];

	if (platform === 'win32') {
		if (availability.bash) next.add('bash');
		else next.delete('bash');

		const powerShellRegistered = registeredTools.includes('powershell');
		if (availability.powershell && powerShellRegistered) next.add('powershell');
		else next.delete('powershell');
		return [...next];
	}

	// Linux/macOS: prune to real availability; never rewrite bash into powershell.
	return prune();
}
