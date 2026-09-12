/**
 * Bridge the native child allowlist gap for PowerShell on Windows.
 *
 * Native subagent definitions historically declare `bash`. Pi itself now has a distinct
 * built-in `powershell` tool, but a child created from an allowlist that contains only `bash`
 * may never register that built-in. change-pi-prompt's shell canonicalizer can only activate
 * tools that exist in the child registry, so a PowerShell-only Windows child could otherwise
 * end up with neither shell even though the owning parent exposes PowerShell.
 *
 * This bridge runs before the main change-pi-prompt before_agent_start handler. For a known
 * shell-capable native child, and only when the owning parent's published shell ceiling allows
 * PowerShell, it dynamically registers Pi's own PowerShell tool definition. The normal runtime
 * then performs availability probing, parent-ceiling enforcement, active-tool reconciliation,
 * and prompt rendering. No pi-subagents runtime or agent definition is modified.
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
} from './subagentCatalog.ts';

export interface ChildPowerShellBridgeOptions {
	platform?: NodeJS.Platform;
	resolveOwnerKey?: () => string | undefined;
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

/** Register the bridge before registerPromptExtension so its hook runs first. */
export function registerChildPowerShellBridge(
	pi: ExtensionAPI,
	agentDir: string,
	options: ChildPowerShellBridgeOptions = {},
): void {
	const platform = options.platform ?? process.platform;
	const resolveOwnerKey = options.resolveOwnerKey ?? (() => resolveShellPolicyOwnerKey());

	pi.on('before_agent_start', (event) => {
		if (platform !== 'win32') return;

		// Fail closed for unknown/custom child identities. The main runtime will still prune shells,
		// but this bridge never broadens a child unless its agent definition explicitly wants one.
		const agentName = getActiveAgentName(event.systemPrompt);
		if (!agentName) return;

		const tools = snapshotTools(pi);
		if (tools.some(tool => tool.name === 'powershell')) return;

		const catalog = loadSubagentCatalog(findSubagentsPackageRoot(tools));
		const childAgent = getAgentFromCatalog(catalog, agentName);
		if (!childAgent || !childAgent.tools.some(isShellToolName)) return;

		const ownerKey = resolveOwnerKey();
		const snapshot = readEffectiveShellPolicySnapshot(agentDir, platform, ownerKey);
		if (toShellCeiling(snapshot)?.powershell !== true) return;

		const cwd = typeof event.systemPromptOptions?.cwd === 'string'
			? event.systemPromptOptions.cwd
			: process.cwd();
		pi.registerTool(createPowerShellToolDefinition(cwd));
	});
}
