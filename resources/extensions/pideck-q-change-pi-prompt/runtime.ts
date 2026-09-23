/** Extension lifecycle and commands. Configuration is loaded once, then explicitly reloaded. */
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ContextEvent, ExtensionAPI, ExtensionContext, ToolResultEvent } from '@earendil-works/pi-coding-agent';
import {
	initializeSubagentDescription,
	initializeSettings,
	ensureStandaloneSubagentForegroundSafe,
	isPiSubagentsSkillPath,
	loadSettings,
	rewriteJsonStrings,
	rewriteSystemPromptTools,
	rewriteToolResultContent,
	validateStandaloneWorkflowScript,
	type Settings,
} from './config.ts';
import { isRecord, isSubagent, type ToolSnapshot } from './contributions.ts';
import {
	getActiveAgentName,
	isChildCoordinationTool,
	isShellToolName,
	reconcileChildActiveShellTools,
	reconcileChildExtensionTools,
	resolveEffectiveShellPolicy,
	toParentActiveTools,
	toShellCeiling,
} from './childShellPolicy.ts';
import {
	findSubagentsPackageRoot,
	getAgentFromCatalog,
	loadSubagentCatalog,
	type SubagentCatalog,
} from './subagentCatalog.ts';
import {
	reconcileChildEnvironments,
	readEffectiveShellPolicySnapshot,
	resolveCurrentChangePiPromptPath,
	resolveShellPolicyOwnerKey,
	type ReconciliationLockOptions,
	type ReconciliationResult,
} from './childReconciliation.ts';
import {
	defaultShellProbeHost,
	hideUnavailableShellTools,
	hideUnavailableSearchTools,
	parseShellPathFromSettings,
	probeShellAvailability,
	probeSearchAvailability,
	type ShellAvailability,
	type ShellProbeHost,
} from './shellAvailability.ts';
import { transformSystemPrompt } from './transform.ts';

export interface ReconciliationOutcome {
	ok: boolean;
	diagnostics: string[];
	reconciliationResult?: ReconciliationResult;
	reason?: string;
}

export function isStandalonePiExecutable(execPath: string = process.execPath): boolean {
	const name = basename(execPath);
	return /^pi(?:\.exe)?$/i.test(name);
}

export interface PromptExtensionOptions {
	probeHost?: ShellProbeHost;
	isStandalone?: () => boolean;
	changePiPromptPath?: string;
	lock?: ReconciliationLockOptions;
}

export const CHILD_TOOL_MARKER_START = '<!-- change-pi-prompt:child-tools:v1 -->';
export const CHILD_TOOL_MARKER_END = '<!-- /change-pi-prompt:child-tools:v1 -->';

const BLOCKED_SCHEDULE_ACTIONS = new Set([
	'schedule.run',
	'schedule.run-due',
	'schedule.resume',
	'schedule.create',
]);

export function isChildSession(systemPrompt: string, _options?: { customPrompt?: string }): boolean {
	// Bundled native children are explicitly tagged by pi-subagents. A generic customPrompt is not
	// a child identity signal: parent sessions may also use --system-prompt, SYSTEM.md, or templates.
	if (getActiveAgentName(systemPrompt) !== undefined) return true;
	// Keep recognizing our own marker on subsequent turns even if an upstream prompt layer changes.
	return systemPrompt.includes(CHILD_TOOL_MARKER_START);
}

export function buildChildToolEnvironmentBlock(activeTools: readonly string[]): string {
	const hasBash = activeTools.includes('bash');
	const hasPowerShell = activeTools.includes('powershell');
	const lines = [
		CHILD_TOOL_MARKER_START,
		'## Child Tool Environment',
		'- Available tools below are authoritative for this runtime.',
		`- Active tools: ${activeTools.join(', ') || '(none)'}. This list overrides tool names in the role prompt.`,
	];

	if (!hasBash && !hasPowerShell) {
		lines.push('- No shell tool is available; use only the non-shell tools that are active in this child.');
	} else {
		lines.push(hasBash
			? '- `bash` is available.'
			: '- `bash` is unavailable. Do not call it, even if the role prompt mentions bash.');
		lines.push(hasPowerShell
			? (hasBash ? '- `powershell` is available.' : '- `powershell` is available; use `powershell` for shell commands.')
			: '- `powershell` is unavailable.');
	}
	for (const name of ['grep', 'find'] as const) {
		if (!activeTools.includes(name)) lines.push(`- \`${name}\` is unavailable. Do not call it, even if the role prompt mentions it.`);
	}
	if ((!activeTools.includes('grep') || !activeTools.includes('find')) && hasPowerShell) {
		lines.push('- For file discovery/search, use `powershell` with Get-ChildItem and Select-String instead.');
	}
	lines.push(CHILD_TOOL_MARKER_END);
	return lines.join('\n');
}

export function injectChildToolEnvironment(systemPrompt: string, activeTools: readonly string[]): string {
	const block = buildChildToolEnvironmentBlock(activeTools);
	const startIdx = systemPrompt.indexOf(CHILD_TOOL_MARKER_START);
	const endIdx = systemPrompt.indexOf(CHILD_TOOL_MARKER_END);

	if (startIdx >= 0 && endIdx >= startIdx) {
		const before = systemPrompt.slice(0, startIdx).trimEnd();
		const after = systemPrompt.slice(endIdx + CHILD_TOOL_MARKER_END.length).trimStart();
		return before + (before ? '\n\n' : '') + block + (after ? '\n\n' + after : '');
	}

	return systemPrompt.trimEnd() + '\n\n' + block;
}

/** Local facts are labeled as local, never treated as the shell execution backend. */
function hostOs(): string {
	if (os.platform() === 'win32') return os.version();
	if (os.platform() === 'darwin') return 'macOS';
	return os.type();
}
function localDate(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Stable identity of the runtime owning this session, used to scope parent-published state. */
function readSessionIdentity(ctx: ExtensionContext): string | undefined {
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		return typeof id === 'string' && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

/** Copy metadata at the event boundary; never mutate the host's tool or options objects. */
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

/** Avoid echoing JSON/template contents or raw stack traces to logs. */
function errorSummary(error: unknown): string {
	if (isRecord(error) && typeof error.code === 'string') return `I/O error ${error.code}`;
	return error instanceof Error ? error.message : 'Unknown extension error';
}

/** rewriteJsonStrings preserves array structure; only string leaves may change. */
function isMessageArray(value: unknown): value is ContextEvent['messages'] {
	return Array.isArray(value);
}
function isContentArray(value: unknown): value is ToolResultEvent['content'] {
	return Array.isArray(value);
}

/** Order-preserving comparison used to skip redundant setActiveTools calls. */
function sameToolList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((name, index) => name === b[index]);
}

export function registerPromptExtension(
	pi: ExtensionAPI,
	agentDir: string,
	optionsOrProbeHost?: ShellProbeHost | PromptExtensionOptions,
): void {
	const options: PromptExtensionOptions = optionsOrProbeHost && ('hasCommand' in optionsOrProbeHost || 'platform' in optionsOrProbeHost)
		? {
			probeHost: optionsOrProbeHost as ShellProbeHost,
			isStandalone: 'isStandalone' in optionsOrProbeHost ? (optionsOrProbeHost as { isStandalone?: () => boolean }).isStandalone : undefined,
			changePiPromptPath: 'changePiPromptPath' in optionsOrProbeHost ? (optionsOrProbeHost as { changePiPromptPath?: string }).changePiPromptPath : undefined,
		}
		: ((optionsOrProbeHost as PromptExtensionOptions | undefined) ?? {});

	const defaultHost = defaultShellProbeHost();
	const probeHost: ShellProbeHost = options.probeHost
		? {
			...defaultHost,
			isExecutableFile: options.probeHost.isExecutableFile,
			...options.probeHost,
		}
		: defaultHost;
	const isStandalone = options.isStandalone ?? (() => isStandalonePiExecutable());
	const changePiPromptPath = options.changePiPromptPath ?? resolveCurrentChangePiPromptPath();

	let settings: Settings | undefined;
	let loading: Promise<void> | undefined;
	let lastStatus = ['尚未转换提示词'];
	let lastPreview: string | undefined;
	let lastShellStatus: string[] = [];
	const warned = new Set<string>();
	const contributionHashes = new Map<string, string>();
	const confirmedSubagentToolNames = new Set<string>();

	let catalog: SubagentCatalog | undefined;
	let reconciliationResult: ReconciliationResult | undefined;
	/** Set on every before_agent_start; true while this runtime is a native child session. */
	let childSessionActive = false;
	let childPermittedTools: Set<string> | undefined;
	/** Parent-owned key that scopes the published shell ceiling to this runtime. */
	let shellPolicyOwnerKey: string | undefined;
	/** Resolved once per child session so a later parent-session switch cannot re-point this child. */
	let childShellPolicyOwnerKey: string | undefined;

	function promptExtensionEnabled(): boolean {
		return settings?.config.enabled === true;
	}

	function subagentAdaptationEnabled(): boolean {
		return settings?.config.enabled === true && settings.config.subagent === true;
	}

	const updateConfirmedSubagentTools = () => {
		confirmedSubagentToolNames.clear();
		for (const tool of snapshotTools(pi)) {
			if (isSubagent(tool)) {
				confirmedSubagentToolNames.add(tool.name);
			}
		}
	};

	/**
	 * Global child-environment reconciliation. Only the parent runtime may run this: a child session
	 * shares the same settings.json, and its own active tools are not the parent's, so a child that
	 * reconciled would rewrite (and degrade) the overrides every other child depends on.
	 */
	const runReconciliation = async (activeTools?: readonly string[]): Promise<ReconciliationOutcome> => {
		const diagnostics: string[] = [];
		if (!subagentAdaptationEnabled()) {
			return { ok: false, diagnostics, reason: 'subagent adaptation is disabled' };
		}
		if (childSessionActive) {
			return { ok: false, diagnostics, reason: 'child sessions must not reconcile environment' };
		}
		if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') {
			const line = 'child-reconciliation-failed: getActiveTools or setActiveTools API unavailable';
			lastStatus.push(line);
			diagnostics.push(line);
			return { ok: false, diagnostics, reason: '环境缺少活动工具 API (getActiveTools/setActiveTools)' };
		}
		try {
			const tools = snapshotTools(pi);
			// Registered tools are not the parent's truth; the final active set decides what a child may keep.
			const effectiveActive = activeTools ?? [...pi.getActiveTools()];
			const pkgRoot = findSubagentsPackageRoot(tools);
			catalog = loadSubagentCatalog(pkgRoot);
			const availability = await probeShells();
			const next = await reconcileChildEnvironments({
				agentDir,
				catalog,
				parentTools: tools,
				parentActiveTools: effectiveActive,
				platform: probeHost.platform,
				shellPolicy: resolveEffectiveShellPolicy({
					platform: probeHost.platform,
					availability,
					parentTools: tools,
					parentActiveTools: effectiveActive,
				}),
				hostShells: { bash: availability.bash, powershell: availability.powershell },
				changePiPromptPath,
				shellPolicyOwnerKey,
				lock: options.lock,
			});
			if (!next) {
				// The reconciliation lock could not be acquired: shared files are left untouched.
				const line = 'child-reconciliation-skipped: reconciliation lock unavailable';
				lastStatus.push(line);
				diagnostics.push(line);
				return { ok: false, diagnostics, reason: 'reconciliation lock unavailable' };
			}
			reconciliationResult = next;
			for (const [name, status] of reconciliationResult.compatibilityStatus) {
				if (!status.ok) {
					const line = `child-compat: ${name} missing [${status.missingTools.join(', ')}]`;
					lastStatus.push(line);
					diagnostics.push(line);
				}
			}
			if (!next.canSafelyDispatch) {
				const line = 'child-reconciliation-failed: policy snapshot or settings write failed';
				lastStatus.push(line);
				diagnostics.push(line);
				return {
					ok: false,
					diagnostics,
					reconciliationResult: next,
					reason: '未能成功原子发布策略快照或配置写入失败',
				};
			}
			return { ok: true, diagnostics, reconciliationResult: next };
		} catch (error) {
			const line = `child-reconciliation-error: ${errorSummary(error)}`;
			lastStatus.push(line);
			diagnostics.push(line);
			return { ok: false, diagnostics, reason: line };
		}
	};

	const report = (ctx: ExtensionContext, message: string, error = false) => {
		if (ctx.hasUI) ctx.ui.notify(message, error ? 'warning' : 'info');
		else process.stderr.write(`[change-pi-prompt] ${message}\n`);
	};
	const warnOnce = (ctx: ExtensionContext, message: string) => {
		if (warned.has(message)) return;
		if (warned.size >= 64) warned.clear();
		warned.add(message);
		report(ctx, message, true);
	};
	/** Read-only catalog load. Safe in child sessions: it never touches shared settings. */
	const loadCatalogSnapshot = () => {
		catalog = loadSubagentCatalog(findSubagentsPackageRoot(snapshotTools(pi)));
	};

	const reload = async () => {
		// Assign only after the whole snapshot validates, retaining last-good settings on errors.
		// Reconciliation is deliberately not run here: global child overrides are owned by the
		// parent's before_agent_start pass, never by a config reload or a child session.
		settings = await loadSettings(agentDir);
	};
	const ensureLoaded = async (ctx: ExtensionContext) => {
		if (!loading) {
			loading = reload().catch(error => {
				warnOnce(ctx, `配置加载失败；${settings ? '保留上次有效配置' : '暂不改写提示词'}：${errorSummary(error)}`);
			});
		}
		await loading;
	};

	const readConfiguredShellPath = async (): Promise<string | undefined> => {
		try {
			return parseShellPathFromSettings(await readFile(join(agentDir, 'settings.json'), 'utf8'));
		} catch {
			return undefined;
		}
	};

	/** Probe the real shell backends once per pass and record the status line. */
	const probeShells = async (): Promise<ShellAvailability> => {
		const availability = probeShellAvailability(probeHost, await readConfiguredShellPath());
		lastShellStatus = [`shell: bash=${availability.bash ? 'available' : 'missing'}, powershell=${availability.powershell ? 'available' : 'missing'}`];
		return availability;
	};

	/** Hide bash/powershell with no backend before the model sees the catalog.
	 *  Run on session_start and again on before_agent_start so later setActiveTools (plan-mode, /reload) cannot resurrect a missing shell. */
	const pruneUnavailableShells = async (
		ctx: ExtensionContext,
		_options: { forChild?: boolean } = {},
	): Promise<{ next: string[]; availability: ShellAvailability } | undefined> => {
		if (!promptExtensionEnabled() || !settings?.config.pruneUnavailableShells) return undefined;
		if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') return undefined;
		const availability = await probeShells();
		const active = [...pi.getActiveTools()];
		const { next, hidden } = hideUnavailableShellTools(active, availability);
		if (hidden.length === 0) return { next, availability };
		pi.setActiveTools(next);
		lastShellStatus.push(`shell-tools: hid ${hidden.join(', ')}`);
		for (const name of hidden) {
			warnOnce(ctx, `${name} 后端不可用，已对本会话隐藏该工具并省略对应提示。`);
		}
		return { next, availability };
	};

	/** Prune grep/find when their rg/fd backends are unavailable; recheck on each turn. */
	const pruneUnavailableSearch = (ctx: ExtensionContext): string[] | undefined => {
		if (!promptExtensionEnabled() || !settings?.config.pruneUnavailableSearchTools) return undefined;
		if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') return undefined;
		const availability = probeSearchAvailability(probeHost, agentDir);
		const { next, hidden } = hideUnavailableSearchTools(pi.getActiveTools(), availability);
		if (hidden.length > 0) {
			pi.setActiveTools(next);
			lastShellStatus.push(`search-tools: hid ${hidden.join(', ')}`);
			for (const name of hidden) warnOnce(ctx, `${name} 的 rg/fd 后端不可用，已对本会话隐藏该工具。`);
		}
		return next;
	};

	pi.on('session_start', async (_event, ctx) => {
		warned.clear();
		contributionHashes.clear();
		confirmedSubagentToolNames.clear();
		updateConfirmedSubagentTools();
		lastPreview = undefined;
		lastShellStatus = [];
		lastStatus = ['尚未转换提示词'];
		childSessionActive = false;
		childPermittedTools = undefined;
		childShellPolicyOwnerKey = undefined;
		await ensureLoaded(ctx);
		if (!promptExtensionEnabled()) return;
		// Session-local only: shell pruning never writes shared state, so it stays here.
		await pruneUnavailableShells(ctx);
		pruneUnavailableSearch(ctx);
		if (lastShellStatus.length) lastStatus = [...lastStatus, ...lastShellStatus];
	});

	pi.on('session_shutdown', async () => {
		lastPreview = undefined;
		warned.clear();
		contributionHashes.clear();
		confirmedSubagentToolNames.clear();
		childSessionActive = false;
		childPermittedTools = undefined;
		childShellPolicyOwnerKey = undefined;
	});

	pi.on('before_agent_start', async (event, ctx) => {
		await ensureLoaded(ctx);
		if (!promptExtensionEnabled()) return;
		try {
			updateConfirmedSubagentTools();
			const childSession = isChildSession(event.systemPrompt, event.systemPromptOptions);
			childSessionActive = childSession;

			// `subagent:false` means no child-specific prompt/tool adaptation. Ordinary session_start
			// shell pruning remains an extension-wide behavior, but this hook must not prune child
			// shells or inject child guidance when subagent adaptation is disabled.
			if (childSession && !subagentAdaptationEnabled()) return;

			if (childSession) {
				childShellPolicyOwnerKey ??= resolveShellPolicyOwnerKey();
			}

			await pruneUnavailableShells(ctx, { forChild: childSession });
			const searchPruned = pruneUnavailableSearch(ctx);
			const tools = snapshotTools(pi);
			const hasActiveToolsApi = typeof pi.getActiveTools === 'function';
			const activeTools = hasActiveToolsApi
				? (searchPruned ?? [...pi.getActiveTools()])
				: tools.map(t => t.name);

			// Child session: do not replace role prompt or transform into "You are Pi"; only inject tool compatibility.
			if (childSession) {
				if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') {
					childPermittedTools = new Set();
					lastStatus = ['child-subagent-mode: getActiveTools or setActiveTools API unavailable, fail closed'];
					return;
				}
				const availability = await probeShells();
				const childCatalog = catalog ?? loadSubagentCatalog(findSubagentsPackageRoot(tools));
				const agentName = getActiveAgentName(event.systemPrompt);
				const childAgent = agentName ? getAgentFromCatalog(childCatalog, agentName) : undefined;
				// Shell capability must come from the agent definition: the child's own list may already be pruned.
				const wantsShell = !!childAgent && (childAgent.tools.some(isShellToolName) || childAgent.hostShell === true);
				// A valid owner snapshot is authoritative. Without one, fail closed: a child
				// cannot infer the parent's active tools from its own registry or allowlist.
				const snapshot = readEffectiveShellPolicySnapshot(agentDir, probeHost.platform, childShellPolicyOwnerKey);
				const ceiling = toShellCeiling(snapshot);
				const parentActiveTools = toParentActiveTools(snapshot);

				// The shared settings.json only decides which providers the child can load;
				// the parent's active tools ceiling applies to builtins and extensions alike.
				// Without a snapshot, only child-only coordination tools survive.
				const extensionPruned = reconcileChildExtensionTools({
					registeredTools: tools,
					activeTools,
					parentActiveTools,
				});
				const reconciled = reconcileChildActiveShellTools({
					platform: probeHost.platform,
					availability,
					registeredTools: tools,
					activeTools: extensionPruned,
					wantsShell,
					ceiling,
					// Unknown identity: prune only, never strip a still-permitted declared shell.
					pruneOnly: !childAgent,
				});

				childPermittedTools = new Set(reconciled);
				let childActiveTools = activeTools;
				if (!sameToolList(reconciled, activeTools) && typeof pi.setActiveTools === 'function') {
					pi.setActiveTools(reconciled);
					childActiveTools = reconciled;
				}

				const nextPrompt = injectChildToolEnvironment(event.systemPrompt, childActiveTools);
				lastStatus = ['child-subagent-mode: preserved role prompt, injected tool environment', ...lastShellStatus];
				if (nextPrompt !== event.systemPrompt) {
					return { systemPrompt: nextPrompt };
				}
				return;
			}

			// Parent session: full prompt transformation. Reconciliation must run after pruning so
			// the child tool environment follows the final active tools, not the registered registry.
			// Scope the published ceiling to this parent so parallel sessions sharing one agentDir
			// cannot overwrite each other's shell policy.
			shellPolicyOwnerKey = readSessionIdentity(ctx) ?? resolveShellPolicyOwnerKey() ?? shellPolicyOwnerKey ?? `pid-${process.pid}`;
			const reconciliationStatus = await runReconciliation(activeTools);

			const nativeTools = tools.filter(tool => activeTools.includes(tool.name) && isSubagent(tool));
			const standalone = isStandalone();
			const nativeAsync = (subagentAdaptationEnabled() && standalone && nativeTools.length)
				? await ensureStandaloneSubagentForegroundSafe(agentDir)
				: undefined;

			const rewritten = subagentAdaptationEnabled()
				? rewriteSystemPromptTools(event.systemPrompt, nativeTools, { standalone })
				: { systemPrompt: event.systemPrompt, rewritten: [] };

			const effectiveConfig = hasActiveToolsApi
				? settings!.config
				: { ...settings!.config, pruneUnavailableShells: false, pruneUnavailableSearchTools: false };

			const result = transformSystemPrompt({
				systemPrompt: rewritten.systemPrompt,
				options: event.systemPromptOptions,
				tools,
				activeTools,
				config: effectiveConfig,
				prompts: settings!.prompts,
				hostOs: hostOs(), today: localDate(),
			});
			lastStatus = [...result.diagnostics, ...reconciliationStatus.diagnostics, ...lastShellStatus];
			if (nativeAsync) {
				lastStatus.push(nativeAsync.message);
				if (!nativeAsync.ok) warnOnce(ctx, nativeAsync.message);
			}
			if (rewritten.rewritten.length) lastStatus.push(`rewrote upstream async default in: ${rewritten.rewritten.join(', ')}`);
			for (const tool of tools.filter(tool => activeTools.includes(tool.name) && isSubagent(tool))) {
				const hash = createHash('sha256').update(JSON.stringify(tool.promptGuidelines ?? [])).digest('hex').slice(0, 12);
				const previous = contributionHashes.get(tool.name);
				if (previous && previous !== hash) warnOnce(ctx, `${tool.name} 的上游指南在本会话内发生变化；按当前来源规则处理，请检查替代文案。`);
				contributionHashes.set(tool.name, hash);
				lastStatus.push(`${tool.name} guidelines fingerprint: ${hash}`);
			}
			// Do not keep project context in an extra global buffer; preview is base-only and bounded.
			const end = result.systemPrompt.indexOf('<!-- /change-pi-prompt:v1 -->');
			lastPreview = result.systemPrompt.startsWith('<!-- change-pi-prompt:v1 -->') && end >= 0 && end < 128 * 1024
				? result.systemPrompt.slice(0, end + '<!-- /change-pi-prompt:v1 -->'.length) : undefined;
			for (const diagnostic of result.diagnostics) {
				if (diagnostic.includes('original preserved')) warnOnce(ctx, diagnostic);
			}
			if (result.systemPrompt !== event.systemPrompt) return { systemPrompt: result.systemPrompt };
		} catch (error) {
			lastStatus = ['transform-error: original preserved'];
			lastPreview = undefined;
			warnOnce(ctx, `改写失败，保留原提示词：${errorSummary(error)}`);
		}
	});

	pi.on('context', (event) => {
		if (!promptExtensionEnabled() || !subagentAdaptationEnabled()) return;
		const rewritten = rewriteJsonStrings(event.messages, { standalone: isStandalone() });
		if (!rewritten.changed || !isMessageArray(rewritten.value)) return;
		lastStatus.push('rewrote upstream async default in context messages');
		return { messages: rewritten.value };
	});

	pi.on('before_provider_request', (event) => {
		if (!promptExtensionEnabled() || !subagentAdaptationEnabled()) return;
		const rewritten = rewriteJsonStrings(event.payload, { standalone: isStandalone() });
		if (!rewritten.changed) return;
		lastStatus.push('rewrote upstream async default in provider payload');
		return rewritten.value;
	});

	pi.on('tool_result', (event) => {
		if (!promptExtensionEnabled() || !subagentAdaptationEnabled()) return;
		if (event.toolName !== 'read' || event.isError) return;
		const path = isRecord(event.input) && typeof event.input.path === 'string' ? event.input.path : undefined;
		if (!isPiSubagentsSkillPath(path)) return;
		const rewritten = rewriteToolResultContent(event.content, { standalone: isStandalone() });
		const nextContent = rewritten.content;
		if (!rewritten.changed || !isContentArray(nextContent)) return;
		lastStatus.push('rewrote upstream async default in pi-subagents skill read');
		return { content: [...nextContent] };
	});

	pi.on('tool_call', async (event) => {
		if (!settings) {
			try {
				settings = await loadSettings(agentDir);
			} catch {
				// keep undefined
			}
		}
		if (!promptExtensionEnabled() || !subagentAdaptationEnabled()) return;

		// --- CHILD SESSION EXECUTION-TIME GATE ---
		if (childSessionActive) {
			// Step 4.5: Nested execution delegation boundary:
			// If child exposes subagent and tries to run an execution-type delegation, block it.
			if (confirmedSubagentToolNames.has(event.toolName) || event.toolName === 'subagent') {
				const input = (isRecord(event.input) ? event.input : undefined) as Record<string, unknown> | undefined;
				const action = typeof input?.action === 'string' ? input.action.trim() : undefined;
				const hasAction = typeof action === 'string' && action.length > 0;
				const isBlockedScheduleAction = hasAction && BLOCKED_SCHEDULE_ACTIONS.has(action);
				const isExecution = !hasAction
					|| isBlockedScheduleAction
					|| typeof input?.task === 'string'
					|| typeof input?.workflowScript === 'string'
					|| typeof input?.workflow === 'string';
				if (isExecution) {
					return {
						block: true,
						reason: '[change-pi-prompt] 子 Agent 不支持发起到下一级子 Agent 的执行型委派。',
					};
				}
				return;
			}

			// Child coordination tools are exempted from parent active tools ceiling
			if (isChildCoordinationTool(event.toolName)) {
				return;
			}

			// Non-coordination tools: fail closed if getActiveTools or setActiveTools API is missing
			if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') {
				return {
					block: true,
					reason: '[change-pi-prompt] 环境缺少 getActiveTools 或 setActiveTools API，无法保证子 Agent 工具安全边界；阻断普通工具调用。',
				};
			}

			if (!childPermittedTools || !childPermittedTools.has(event.toolName)) {
				return {
					block: true,
					reason: `[change-pi-prompt] 工具 "${event.toolName}" 不在子 Agent 启动时允许的工具集合中。`,
				};
			}

			// Re-read parent owner snapshot freshly from disk
			const snapshot = readEffectiveShellPolicySnapshot(agentDir, probeHost.platform, childShellPolicyOwnerKey);
			if (!snapshot || snapshot.version !== 2) {
				return {
					block: true,
					reason: '[change-pi-prompt] 缺少有效的父会话工具授权快照 (version 2)；子 Agent 拒绝执行普通工具。',
				};
			}

			if (!snapshot.parentActiveTools.includes(event.toolName)) {
				return {
					block: true,
					reason: `[change-pi-prompt] 工具 "${event.toolName}" 已被父会话撤销或未被父会话启用。`,
				};
			}

			// Backend availability checks for shells and search tools
			if (event.toolName === 'bash') {
				const avail = await probeShells();
				if (!snapshot.shell.bash || !avail.bash) {
					return {
						block: true,
						reason: '[change-pi-prompt] bash 后端在父会话中被禁用或在本地不可用。',
					};
				}
			} else if (event.toolName === 'powershell') {
				const avail = await probeShells();
				if (!snapshot.shell.powershell || !avail.powershell) {
					return {
						block: true,
						reason: '[change-pi-prompt] powershell 后端在父会话中被禁用或在本地不可用。',
					};
				}
			} else if (event.toolName === 'grep' || event.toolName === 'find') {
				const searchAvail = probeSearchAvailability(probeHost, agentDir);
				if (!searchAvail[event.toolName]) {
					return {
						block: true,
						reason: `[change-pi-prompt] ${event.toolName} 后端 (rg/fd) 不可用。`,
					};
				}
			}

			return;
		}

		// --- PARENT SESSION EXECUTION-TIME GATE ---
		if (confirmedSubagentToolNames.size === 0) {
			updateConfirmedSubagentTools();
		}
		if (!confirmedSubagentToolNames.has(event.toolName) && event.toolName !== 'subagent') return;

		const input = (isRecord(event.input) ? event.input : undefined) as Record<string, unknown> | undefined;
		if (!input) return;

		// Management action: not an execution call (e.g. action: 'list' | 'status' | 'guide')
		if (typeof input.action === 'string' && input.action.trim().length > 0) {
			const action = input.action.trim();
			if (typeof input.task === 'string' && input.task.trim().length > 0) {
				return {
					block: true,
					reason: '[change-pi-prompt] 参数错误：action 不能与 task 混用。',
				};
			}
			if (input.action !== 'validate' && (input.workflowScript || input.workflowScriptPath || input.workflow)) {
				return {
					block: true,
					reason: '[change-pi-prompt] 参数错误：非 validate action 不能包含 workflow/workflowScript。',
				};
			}
			if (BLOCKED_SCHEDULE_ACTIONS.has(action)) {
				return {
					block: true,
					reason: `[change-pi-prompt] 安全限制：不支持通过 "${action}" 触发或恢复计划任务执行。`,
				};
			}
			return;
		}

		if (!catalog) {
			// Read-only: children need the catalog for standalone AST validation but must not reconcile.
			loadCatalogSnapshot();
		}

		const standalone = isStandalone();

		// Standalone Pi: reject workflowScriptPath and named workflow resources
		if (standalone && typeof input.workflowScriptPath === 'string' && input.workflowScriptPath.trim().length > 0) {
			return {
				block: true,
				reason: '[change-pi-prompt] standalone Pi 环境暂不支持 workflowScriptPath；请使用 inline workflowScript，以便执行 foreground AST 校验。',
			};
		}

		if (standalone && typeof input.workflow === 'string' && input.workflow.trim().length > 0) {
			return {
				block: true,
				reason: '[change-pi-prompt] standalone Pi 环境暂不支持 named workflow resource；请使用 inline workflowScript。',
			};
		}

		const targetAgentName = typeof input.agent === 'string' ? input.agent.trim() : undefined;
		const catalogEntry = targetAgentName && catalog ? getAgentFromCatalog(catalog, targetAgentName) : undefined;
		const runnerType = catalogEntry?.runnerType ?? (targetAgentName ? 'unknown' : 'native');

		// External runners: must not be converted to async:false
		if (runnerType === 'external-cli' || runnerType === 'external-job') {
			if (standalone) {
				return {
					block: true,
					reason: `[change-pi-prompt] Agent "${targetAgentName}" 使用 external runner (${runnerType})，只支持 async/background，当前 standalone Pi 环境不可执行。`,
				};
			}
			return;
		}

		// Standalone direct agent: unknown runner must be blocked fail-closed
		if (standalone && targetAgentName && runnerType === 'unknown') {
			return {
				block: true,
				reason: `[change-pi-prompt] 无法确认 Agent "${targetAgentName}" 的 runner 类型；standalone Pi 下拒绝执行。`,
			};
		}

		// Fail closed if active tools API is unavailable
		if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') {
			return {
				block: true,
				reason: '[change-pi-prompt] 环境缺少 getActiveTools 或 setActiveTools API，无法保证子 Agent 工具安全边界；阻断子 Agent 执行。',
			};
		}

		// Fresh reconciliation before launch: re-read parent active tools, reconcile, and publish fresh snapshot
		const preTools = [...pi.getActiveTools()];
		const recon = await runReconciliation(preTools);
		if (!recon.ok || !recon.reconciliationResult) {
			return {
				block: true,
				reason: `[change-pi-prompt] 无法完成子 Agent 环境协调：${recon.reason ?? '协调失败'}。`,
			};
		}

		// Check if active tools changed during async reconciliation
		const postTools = [...pi.getActiveTools()];
		if (!sameToolList(preTools, postTools)) {
			return {
				block: true,
				reason: '[change-pi-prompt] 父会话活动工具集在委派协调期间发生变化；已中止调用，请重试。',
			};
		}

		// Native direct agent: verify required tool providers from fresh reconciliation
		if (targetAgentName) {
			const compat = recon.reconciliationResult.compatibilityStatus.get(targetAgentName);
			if (compat && !compat.ok) {
				return {
					block: true,
					reason: `[change-pi-prompt] Agent "${targetAgentName}" requires ${compat.missingTools.join(', ')}, but no child-loadable provider was found for that active tool.`,
				};
			}
			if (recon.reconciliationResult.incompatibleAgents.includes(targetAgentName)) {
				return {
					block: true,
					reason: `[change-pi-prompt] Agent "${targetAgentName}" has subagentOnlyExtensions disabled in settings.json, preventing child tool environment reconciliation.`,
				};
			}
		}

		// Workflow script: validate bounded async in standalone
		if (standalone && typeof input.workflowScript === 'string') {
			const validation = validateStandaloneWorkflowScript(input.workflowScript, catalog);
			if (!validation.ok) {
				return {
					block: true,
					reason: validation.reason ?? '[change-pi-prompt] standalone Pi 环境拒绝不安全的 workflowScript。',
				};
			}
		}

		// Standalone native child: enforce foreground execution
		if (standalone) {
			const check = await ensureStandaloneSubagentForegroundSafe(agentDir);
			if (!check.ok) {
				return {
					block: true,
					reason: `[change-pi-prompt] 阻止 subagent 调用：独立 Pi 环境要求 asyncByDefault=false 且 forceTopLevelAsync!=true。请检查 ${check.path}。（${check.message}）`,
				};
			}
			input.async = false;
			input.foregroundOnly = true;
		}
	});

	pi.registerCommand('change-pi-prompt', {
		description: '提示词替换：status | reload | init | init-subagent | preview',
		handler: async (args, ctx) => {
			try {
				switch (args.trim() || 'status') {
					case 'status':
						await ensureLoaded(ctx);
						report(ctx, [`配置：${join(agentDir, 'change-pi-prompt')}`, `有效配置：${settings ? '已加载' : '无'}`, ...lastStatus].join('\n'));
						break;
					case 'reload':
						await reload();
						loading = Promise.resolve();
						warned.clear();
						lastPreview = undefined;
						lastStatus = ['配置已重载，等待下一次用户请求'];
						report(ctx, '配置已重载；下一次用户请求生效。subagent 工具描述须在新会话注册后生效。');
						break;
					case 'init': {
						const count = await initializeSettings(agentDir);
						report(ctx, `已创建 ${count} 个配置/模板文件，已有文件未覆盖。目录：${join(agentDir, 'change-pi-prompt')}。编辑后执行 /change-pi-prompt reload。`);
						break;
					}
					case 'init-subagent': {
						if (!snapshotTools(pi).some(isSubagent)) {
							report(ctx, '未检测到 pi-subagents 的 subagent 工具；未创建任何文件。', true);
							break;
						}
						const created = await initializeSubagentDescription(agentDir);
						report(ctx, `${created ? '已创建' : '保留已有'} ${join(agentDir, 'subagent-tool-description.md')}。请在 ${join(agentDir, 'extensions', 'subagent', 'config.json')} 顶层设置 toolDescriptionMode 为 custom。standalone Pi 下，如果 subagent config 不存在，change-pi-prompt 会自动创建最小 foreground-safe 配置。已有配置不会自动修改。项目配置目录中的 subagent-tool-description.md 优先；本命令不修改 pi-subagents 配置。上游会自动追加安全指南。独立二进制环境必须显式关闭后台子 agent。`);
						break;
					}
					case 'preview':
						if (!ctx.hasUI || !lastPreview) report(ctx, '暂无可预览的已转换基础提示词，或当前环境不支持编辑器。');
						else await ctx.ui.editor('基础提示词预览（不保存，不含项目/技能上下文）', lastPreview);
						break;
					default:
						report(ctx, '用法：/change-pi-prompt status | reload | init | init-subagent | preview');
				}
			} catch (error) {
				report(ctx, `命令失败；已有有效配置保持不变：${errorSummary(error)}`, true);
			}
		},
	});
}
