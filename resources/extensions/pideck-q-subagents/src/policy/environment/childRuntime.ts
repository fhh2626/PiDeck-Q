/** Enforce the launching parent's permission ceiling inside a native child runtime. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { agentInheritsParentTools, readEffectiveShellPolicySnapshot } from './childReconciliation.ts';
import {
	getActiveAgentName, isChildCoordinationTool, isShellToolName, reconcileChildActiveShellTools,
	reconcileChildExtensionTools, sameToolList, toParentActiveTools, toShellCeiling,
} from './childShellPolicy.ts';
import { getAgentFromCatalog, type SubagentCatalog } from './subagentCatalog.ts';
import { injectChildToolEnvironment } from './childPrompt.ts';
import { isRecord, type ToolSnapshot } from './toolMetadata.ts';
import { toRetentionAvailability, type ShellProbeDetails } from './shellAvailability.ts';
import type { HostEnvironment } from './hostEnvironment.ts';

/** Launching or resuming work requires a fresh policy even when expressed as a management action. */
export function isDelegationExecution(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const action = typeof value.action === 'string' ? value.action.trim() : '';
	return !action || action === 'resume' || action.startsWith('schedule.')
		|| typeof value.task === 'string' || typeof value.workflowScript === 'string'
		|| typeof value.workflowScriptPath === 'string' || typeof value.workflow === 'string';
}

/** A child consumes its parent's policy and cannot expand its launch-time permission set. */
export function createChildRuntime(input: {
	pi: ExtensionAPI;
	agentDir: string;
	host: HostEnvironment;
	ownerKey: string | undefined;
	allowNested?: boolean;
}) {
	const { pi, agentDir, host, ownerKey } = input;
	let permitted: Set<string> | undefined;
	const snapshot = () => readEffectiveShellPolicySnapshot(agentDir, host.probeHost.platform, ownerKey);
	const prepare = (
		systemPrompt: string,
		tools: ToolSnapshot[],
		catalog: SubagentCatalog,
		details: ShellProbeDetails,
	): string | undefined => {
		if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') {
			permitted = new Set();
			return;
		}
		const active = [...pi.getActiveTools()];
		const name = getActiveAgentName(systemPrompt);
		const agent = name ? getAgentFromCatalog(catalog, name) : undefined;
		const parent = snapshot();
		const wantsShell = !!agent && (agent.tools.some(isShellToolName) || agent.hostShell === true
			|| agent.inheritParentTools === true || agentInheritsParentTools(agentDir, agent.name));
		const extensionPruned = reconcileChildExtensionTools({
			registeredTools: tools, activeTools: active, parentActiveTools: toParentActiveTools(parent),
		});
		const next = reconcileChildActiveShellTools({
			platform: host.probeHost.platform,
			availability: toRetentionAvailability(details),
			registeredTools: tools,
			activeTools: extensionPruned,
			wantsShell,
			ceiling: toShellCeiling(parent),
			pruneOnly: !agent,
		});
		permitted = new Set(next);
		if (!sameToolList(active, next)) pi.setActiveTools(next);
		return injectChildToolEnvironment(systemPrompt, next);
	};
	const gate = async (event: { toolName: string; input: unknown }) => {
		const block = (reason: string) => ({ block: true as const, reason: `[subagent] ${reason}` });
		if (event.toolName === 'subagent') {
			if (!isDelegationExecution(event.input)) return;
			if (!input.allowNested) return block('Child agents cannot launch nested delegation.');
		}

		if (isChildCoordinationTool(event.toolName)) return;
		if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') {
			return block('Active tool APIs are unavailable. Child tool execution is blocked.');
		}
		if (!permitted?.has(event.toolName)) return block(`Tool "${event.toolName}" is outside the child's launch-time permissions.`);
		const parent = snapshot();
		if (!parent || parent.version !== 2) return block('A valid parent tool authorization snapshot (version 2) is required.');
		if (!parent.parentActiveTools.includes(event.toolName)) return block(`Tool "${event.toolName}" was disabled or revoked by the parent session.`);
		if (event.toolName === 'bash' || event.toolName === 'powershell') {
			const available = toRetentionAvailability(await host.probeShells());
			if (!parent.shell[event.toolName] || !available[event.toolName]) {
				return block(`${event.toolName} is disabled by the parent or unavailable on this host.`);
			}
		} else if ((event.toolName === 'grep' || event.toolName === 'find') && !host.probeSearch()[event.toolName]) {
			return block(`${event.toolName} backend (rg/fd) is unavailable.`);
		}
	};
	/** Refresh a fanout parent's active set before it can pass tools to a grandchild. */
	const narrowForNested = (): string[] | undefined => {
		const parent = snapshot();
		const permissionSet = permitted;
		if (!permissionSet || parent?.version !== 2 || typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') return;
		const active = pi.getActiveTools();
		const next = active.filter(name => permissionSet.has(name) && (isChildCoordinationTool(name) || parent.parentActiveTools.includes(name)));
		if (!sameToolList(active, next)) pi.setActiveTools(next);
		return next;
	};
	return { prepare, gate, narrowForNested, reset: () => { permitted = undefined; } };
}
