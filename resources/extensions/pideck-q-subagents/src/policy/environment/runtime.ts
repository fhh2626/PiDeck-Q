/** Parent/child tool environment ownership, independent of prompt customization. */
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
	reconcileChildEnvironments, resolveShellPolicyOwnerKey, writeEffectiveShellPolicySnapshot,
	type ReconciliationLockOptions,
} from './childReconciliation.ts';
import { isChildCoordinationTool, resolveEffectiveShellPolicy, sameToolList } from './childShellPolicy.ts';
import { findSubagentsPackageRoot, loadSubagentCatalog } from './subagentCatalog.ts';
import { isRecord, type ToolSnapshot } from './toolMetadata.ts';
import { toKnownHostShells, toRetentionAvailability, type ShellProbeDetails } from './shellAvailability.ts';
import { createHostEnvironment, type HostEnvironmentOptions } from './hostEnvironment.ts';
import { createChildRuntime, isDelegationExecution } from './childRuntime.ts';
import { isChildSession } from './childPrompt.ts';
import { publishPromptAddition } from '../../shared/prompt-sections.ts';
import { isChildLoader } from '../../runs/shared/child-loader-identity.ts';

export { buildChildToolEnvironmentBlock, injectChildToolEnvironment, isChildSession } from './childPrompt.ts';

export interface SubagentEnvironmentOptions extends HostEnvironmentOptions {
	/** Native child hooks set this explicitly even when the agent supplies no role prompt. */
	child?: boolean;
	/** Granted only by the captured native fanout configuration. */
	allowNested?: boolean;
	/** Captured owning session identity from the native launch. */
	ownerKey?: string;
	lock?: ReconciliationLockOptions;
}

export interface SubagentEnvironment {
	/** Direct extension, slash and RPC execution does not pass through Pi's tool_call event. */
	prepareDelegation(input: unknown, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined>;
}

/** Prevent accidental repeated installation on the same extension API. Each loaded extension gets its own API. */
const registered = new WeakMap<ExtensionAPI, SubagentEnvironment>();
const CAPTURED_OWNER_QUERY = 'pideck-subagents:environment-owner-query';

/** Resolve only the mandatory policy bound to this exact SDK session. */
function capturedEnvironment(pi: ExtensionAPI, ctx: ExtensionContext) {
	let claimed = false;
	let guard: SubagentEnvironment['prepareDelegation'] | undefined;
	pi.events?.emit(CAPTURED_OWNER_QUERY, {
		sessionManager: ctx.sessionManager,
		accept: (owner?: SubagentEnvironment) => {
			claimed = true;
			if (typeof owner?.prepareDelegation === 'function') guard = owner.prepareDelegation;
		},
	});
	return { claimed, guard };
}

/** Direct fanout tool execution must use its captured policy even without Pi tool events. */
export async function prepareCapturedChildDelegation(pi: ExtensionAPI, input: unknown, ctx: ExtensionContext) {
	const owner = capturedEnvironment(pi, ctx);
	return owner.guard ? owner.guard(input, ctx)
		: { block: true as const, reason: '[subagent] The captured child execution guard is not bound to this session.' };
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

function sessionIdentity(ctx: ExtensionContext): string | undefined {
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		return typeof id === 'string' && id.length ? id : undefined;
	} catch { return; }
}

/** Register before the extension's child early return so enforcement survives child-only loading. */
export function registerSubagentEnvironment(pi: ExtensionAPI, agentDir: string, options: SubagentEnvironmentOptions = {}): SubagentEnvironment {
	const existing = registered.get(pi);
	if (existing) return existing;
	const host = createHostEnvironment(pi, agentDir, options);
	// Capture both identities during extension loading. Foreground children restore process.env
	// immediately afterward, and another session must never change an existing child's owner.
	const env = { PI_SUBAGENT_CHILD: isChildLoader(pi.events) ? '1' : process.env.PI_SUBAGENT_CHILD };
	const inheritedOwner = options.ownerKey ?? resolveShellPolicyOwnerKey();
	let boundSession: ExtensionContext['sessionManager'] | undefined;
	// Resource loaders may load another copy of the package through a provider path. Its API
	// and module cache differ, so API identity cannot elect one policy. The captured hook claims
	// only its actual bound SessionManager through the loader bus, even if several loaders share it.
	const releaseOwner = options.child === true ? pi.events?.on(CAPTURED_OWNER_QUERY, (query: unknown) => {
		if (boundSession && isRecord(query) && query.sessionManager === boundSession && typeof query.accept === 'function') query.accept(environment);
	}) : undefined;
	const capturedOwner = (ctx: ExtensionContext) => options.child === true
		? { claimed: false, guard: undefined }
		: capturedEnvironment(pi, ctx);
	const capturedOwnerExists = (ctx: ExtensionContext) => capturedOwner(ctx).claimed;
	let childActive = options.child === true || isChildSession('', undefined, env);
	let ownerKey: string | undefined;
	const child = createChildRuntime({ pi, agentDir, host, ownerKey: inheritedOwner, allowNested: options.allowNested });
	const getCatalog = (tools = snapshotTools(pi)) => loadSubagentCatalog(findSubagentsPackageRoot(tools));
	const reconcile = async (active: readonly string[], details?: ShellProbeDetails) => {
		const tools = snapshotTools(pi);
		const shells = details ?? await host.probeShells();
		return reconcileChildEnvironments({
			agentDir,
			catalog: getCatalog(tools),
			parentTools: tools,
			parentActiveTools: active,
			platform: host.probeHost.platform,
			shellPolicy: resolveEffectiveShellPolicy({
				platform: host.probeHost.platform,
				availability: toRetentionAvailability(shells),
				parentTools: tools,
				parentActiveTools: active,
			}),
			hostShells: toKnownHostShells(shells),
			shellPolicyOwnerKey: ownerKey,
			lock: options.lock,
		});
	};
	pi.on('session_start', async (_event, ctx) => {
		boundSession = ctx.sessionManager;
		host.reset();
		child.reset();
		childActive = options.child === true || isChildSession('', undefined, env);
		ownerKey = sessionIdentity(ctx) ?? ownerKey;
		if (capturedOwnerExists(ctx)) return;
		await host.prune(ctx);
	});
	pi.on('session_shutdown', async () => { releaseOwner?.(); boundSession = undefined; child.reset(); host.reset(); });
	pi.on('before_agent_start', async (event, ctx) => {
		if (capturedOwnerExists(ctx)) return;
		if (options.child === true && boundSession !== ctx.sessionManager) { child.reset(); return; }
		childActive = options.child === true || isChildSession(event.systemPrompt, event.systemPromptOptions, env);
		try {
			const details = await host.prune(ctx);
			const tools = snapshotTools(pi);
			if (childActive) {
				const next = child.prepare(event.systemPrompt, tools, getCatalog(tools), details);
				if (next !== undefined) return publishPromptAddition(event, next, 'pideck_child_environment');
				return;
			}
			ownerKey = sessionIdentity(ctx) ?? ownerKey ?? `pid-${process.pid}`;
			if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') return;
			const result = await reconcile([...pi.getActiveTools()], details);
			if (!result?.canSafelyDispatch) host.notify(ctx, 'Unable to publish the child tool environment. Delegation is blocked until it can be reconciled.');
		} catch {
			// Invalid preparation must not leave a prior turn's permission set authoritative.
			if (childActive) child.reset();
			host.notify(ctx, 'Unable to prepare the subagent tool environment. Tool execution will fail closed.');
		}
	});
	const gate = async (event: { toolName: string; input: unknown }, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined> => {
		if (capturedOwnerExists(ctx)) return;
		if (options.child === true && boundSession !== ctx.sessionManager) {
			if (isChildCoordinationTool(event.toolName)) return;
			return { block: true, reason: '[subagent] The captured child tool environment is not bound to this session.' };
		}
		if (childActive) {
			const denied = await child.gate(event);
			if (denied || !options.allowNested || event.toolName !== 'subagent' || !isDelegationExecution(event.input)) return denied;
			const nestedOwner = sessionIdentity(ctx);
			const active = child.narrowForNested();
			if (!active || !nestedOwner || !inheritedOwner || nestedOwner === inheritedOwner) {
				return { block: true, reason: '[subagent] Nested delegation requires a distinct child session and valid inherited permissions.' };
			}
			try {
				const details = await host.probeShells();
				if (!sameToolList(active, pi.getActiveTools())) return { block: true, reason: '[subagent] Child active tools changed during nested delegation. Retry the delegation.' };
				const policy = resolveEffectiveShellPolicy({ platform: host.probeHost.platform, availability: toRetentionAvailability(details), parentTools: snapshotTools(pi), parentActiveTools: active });
				const published = writeEffectiveShellPolicySnapshot(join(agentDir, 'subagents', 'environment'), host.probeHost.platform, policy, nestedOwner, active, inheritedOwner);
				if (!published) return { block: true, reason: '[subagent] Unable to publish the nested child permission snapshot.' };
			} catch {
				return { block: true, reason: '[subagent] Unable to prepare the nested child tool environment.' };
			}
			return;
		}
		if (event.toolName !== 'subagent' || !isRecord(event.input)) return;
		// Tool schemas and execution policy belong to the executor. Environment publication is
		// needed only for launching work, never for status, validation, replies or other reads.
		const args = event.input;
		if (typeof args.action === 'string' && args.action.trim() && args.action.trim() !== 'resume') return;
		if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') {
			return { block: true, reason: '[subagent] Active tool APIs are unavailable. Delegation is blocked.' };
		}
		ownerKey = sessionIdentity(ctx) ?? ownerKey ?? `pid-${process.pid}`;
		const before = [...pi.getActiveTools()];
		try {
			const result = await reconcile(before);
			if (!result) return { block: true, reason: '[subagent] Child reconciliation lock unavailable.' };
			if (!result.canSafelyDispatch) return { block: true, reason: '[subagent] Unable to atomically publish the parent tool environment.' };
			if (!sameToolList(before, pi.getActiveTools())) {
				return { block: true, reason: '[subagent] Parent active tools changed during reconciliation. Retry the delegation.' };
			}
			const name = typeof args.agent === 'string' ? args.agent.trim() : undefined;
			const compatibility = name ? result.compatibilityStatus.get(name) : undefined;
			if (compatibility && !compatibility.ok) {
				return { block: true, reason: `[subagent] Agent "${name}" requires child-loadable providers for ${compatibility.missingTools.join(', ')}.` };
			}
			if (name && result.incompatibleAgents.includes(name)) {
				return { block: true, reason: `[subagent] Agent "${name}" disables child-only extensions required for its tool environment.` };
			}
		} catch {
			return { block: true, reason: '[subagent] Unable to reconcile the child tool environment.' };
		}
	};
	pi.on('tool_call', gate);
	const environment: SubagentEnvironment = {
		async prepareDelegation(input, ctx) {
			const owner = capturedOwner(ctx);
			// Events visit the captured hook later, but a direct entry must explicitly use it.
			// A legacy owner without a callable guard cannot authorize a bypass.
			if (owner.claimed) return owner.guard
				? owner.guard(input, ctx)
				: { block: true, reason: '[subagent] The captured child execution guard is unavailable.' };
			return gate({ toolName: 'subagent', input }, ctx);
		},
	};
	registered.set(pi, environment);
	return environment;
}
