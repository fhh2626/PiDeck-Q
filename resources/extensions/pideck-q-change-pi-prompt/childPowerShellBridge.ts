/**
 * Bridge the native child allowlist gap for PowerShell on Windows.
 *
 * Native subagent definitions historically declare `bash`. Pi's child `tools` list becomes a hard
 * allowlist, so registering a new tool named `powershell` after launch is filtered out when the
 * child only allowed `bash`. To stay inside that real runtime contract, this bridge uses Pi's own
 * PowerShell tool implementation but exposes it through the already-authorized `bash` compatibility
 * slot. The main runtime recognizes the marker and treats that slot as a PowerShell backend.
 *
 * No pi-subagents runtime or agent definition is modified.
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
import {
	CHILD_POWERSHELL_BRIDGE_MARKER,
	isChildPowerShellBridge,
	isPwsh,
	type ToolSnapshot,
} from './contributions.ts';
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

export const CHILD_POWERSHELL_PROMPT_START = '<!-- change-pi-prompt:child-powershell-slot:v1 -->';
export const CHILD_POWERSHELL_PROMPT_END = '<!-- /change-pi-prompt:child-powershell-slot:v1 -->';

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

/** True when the child-visible `bash` name is actually backed by PowerShell. */
export function hasPowerShellBackedBashTool(pi: ExtensionAPI): boolean {
	const bash = snapshotTools(pi).find(tool => tool.name === 'bash');
	return !!bash && (isChildPowerShellBridge(bash) || isPwsh(bash));
}

/** Make the backend/name mismatch explicit to the model without rewriting the agent role prompt. */
export function injectPowerShellBackedBashPrompt(systemPrompt: string): string {
	const block = [
		CHILD_POWERSHELL_PROMPT_START,
		'## Child Shell Backend',
		'- The active tool is named `bash` only because this child allowlist uses the historical shell slot.',
		'- This `bash` tool executes PowerShell, not GNU Bash. Use PowerShell syntax and semantics for every command.',
		'- Do not infer Bash syntax from the tool name or from older role-prompt wording.',
		CHILD_POWERSHELL_PROMPT_END,
	].join('\n');
	const start = systemPrompt.indexOf(CHILD_POWERSHELL_PROMPT_START);
	const end = systemPrompt.indexOf(CHILD_POWERSHELL_PROMPT_END);
	if (start >= 0 && end >= start) {
		const before = systemPrompt.slice(0, start).trimEnd();
		const after = systemPrompt.slice(end + CHILD_POWERSHELL_PROMPT_END.length).trimStart();
		return before + (before ? '\n\n' : '') + block + (after ? '\n\n' + after : '');
	}
	return systemPrompt.trimEnd() + '\n\n' + block;
}

/**
 * Ensure a Windows native child can use the PowerShell backend authorized by its parent.
 * Returns true only when this call replaced the child's `bash` slot with the PowerShell-backed slot.
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
	if (tools.some(isChildPowerShellBridge)) return false;
	// An already-loaded pwsh adapter occupies the allowed `bash` slot with a PowerShell backend.
	// The child canonicalizer understands that provenance, so registering a competing same-name
	// bridge would only make behavior depend on extension load order.
	if (tools.some(isPwsh)) return false;
	// A real `powershell` tool already present is preferable; the normal canonicalizer can activate it.
	if (tools.some(tool => tool.name === 'powershell')) return false;

	const catalog = options.catalog ?? loadSubagentCatalog(findSubagentsPackageRoot(tools));
	const childAgent = getAgentFromCatalog(catalog, agentName);
	// Fail closed for unknown/custom child identities. Only an agent definition that explicitly
	// declares a shell requirement may receive the bridge tool.
	if (!childAgent || !childAgent.tools.some(isShellToolName)) return false;
	// The compatibility slot only makes sense when this child actually authorizes the historical
	// `bash` name. An agent that declares only `powershell` should not be widened under another name.
	if (!childAgent.tools.includes('bash')) return false;

	const ownerKey = options.ownerKey ?? resolveShellPolicyOwnerKey();
	const snapshot = readEffectiveShellPolicySnapshot(agentDir, options.platform, ownerKey);
	const ceiling = toShellCeiling(snapshot);
	// Preserve a real Bash backend when the parent exposes one. The bridge is only the fallback for
	// the common Windows case where Bash is unavailable but PowerShell is authorized.
	if (ceiling?.bash === true) return false;
	if (ceiling?.powershell !== true) return false;

	const powerShell = createPowerShellToolDefinition(options.cwd);
	pi.registerTool({
		...powerShell,
		name: 'bash',
		label: 'bash (PowerShell)',
		description: `${CHILD_POWERSHELL_BRIDGE_MARKER} Compatibility shell slot backed by PowerShell. Use PowerShell syntax; this tool does not execute GNU Bash.\n\n${powerShell.description}`,
		promptSnippet: 'Execute PowerShell commands through the child `bash` compatibility slot',
		promptGuidelines: [
			'The `bash` tool in this child is backed by PowerShell. Use PowerShell syntax and semantics, not GNU Bash syntax.',
			...(powerShell.promptGuidelines ?? []),
		],
	});
	return true;
}
