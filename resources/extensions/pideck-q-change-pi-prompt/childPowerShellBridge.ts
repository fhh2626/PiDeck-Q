/**
 * Bridge the native child allowlist gap for PowerShell on Windows.
 *
 * Native subagent definitions historically declare `bash`. Pi now also has a distinct built-in
 * `powershell` tool, but a child created from an allowlist containing only `bash` may never register
 * that built-in. The shell canonicalizer can only activate a tool that exists in the child registry,
 * so a PowerShell-only Windows child could otherwise end up with neither shell even though its
 * owning parent exposes PowerShell.
 *
 * This helper is called from change-pi-prompt's existing before_agent_start hook, before shell
 * pruning. For a known shell-capable native child, and only when the owning parent's published shell
 * ceiling allows PowerShell, it dynamically registers Pi's own PowerShell tool definition. The normal
 * runtime then performs availability probing, ceiling enforcement, active-tool reconciliation and
 * prompt rendering. No pi-subagents runtime or agent definition is modified.
 */
import {
	createPowerShellToolDefinition,
	type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import {
	readEffectiveShellPolicySnapshot,
	resolveShellPolicyOwnerKey,
} from './childReconciliation.ts';
import {
	getActiveAgentName,
	isShellToolName,
	toShellCeiling,
} from './childShellPolicy.ts';
import { type ToolSnapshot } from './contributions.ts';
import {
	findSubagentsPackageRoot,
	getAgentFromCatalog,
	loadSubagentCatalog,
	type SubagentCatalog,
} from './subagentCatalog.ts';

export interface EnsureChildPowerShellOptions {
	platform: NodeJS.Platform;
	systemPrompt: string;
	cwd: string;
	/** Explicit extension gate. False means zero bridge behavior. */
	enabled?: boolean;
	ownerKey?: string;
	catalog?: SubagentCatalog;
}

function snapshotTools(pi: ExtensionAPI): ToolSnapshot[] {
	if (typeof pi.getAllTools !== 'function') return [];
	return pi.getAllTools().map(tool => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		promptGuidelines: tool.promptGuidelines ? [...tool.promptGuidelines] : [],
		sourceInfo: tool.sourceInfo ? { source: tool.sourceInfo.source, path: tool.sourceInfo.path } : undefined,
	}));
}

/**
 * Ensure a Windows native child can materialize the PowerShell backend authorized by its parent.
 * Returns true only when this call registered the missing tool.
 */
export function ensureChildPowerShellTool(
	pi: ExtensionAPI,
	agentDir: string,
	options: EnsureChildPowerShellOptions,
): boolean {
	if (options.enabled === false) return false;
	if (options.platform !== 'win32') return false;

	const agentName = getActiveAgentName(options.systemPrompt);
	if (!agentName) return false;

	const tools = snapshotTools(pi);
	if (tools.some(tool => tool.name === 'powershell')) return false;

	const catalog = options.catalog ?? loadSubagentCatalog(findSubagentsPackageRoot(tools));
	const childAgent = getAgentFromCatalog(catalog, agentName);
	// Fail closed for unknown/custom child identities. Only an agent definition that explicitly
	// declares a shell requirement may receive the bridge tool.
	if (!childAgent || !childAgent.tools.some(isShellToolName)) return false;

	const ownerKey = options.ownerKey ?? resolveShellPolicyOwnerKey();
	const snapshot = readEffectiveShellPolicySnapshot(agentDir, options.platform, ownerKey);
	if (toShellCeiling(snapshot)?.powershell !== true) return false;

	pi.registerTool(createPowerShellToolDefinition(options.cwd));
	return true;
}
