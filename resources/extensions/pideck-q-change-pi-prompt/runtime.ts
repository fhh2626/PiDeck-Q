/** Extension lifecycle and commands. Configuration is loaded once, then explicitly reloaded. */
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ContextEvent, ExtensionAPI, ExtensionContext, ToolResultEvent } from '@earendil-works/pi-coding-agent';
import {
	hasExplicitAsyncTrueInScript,
	initializeSubagentDescription,
	initializeSettings,
	inspectNativeSubagentAsyncDefault,
	isPiSubagentsSkillPath,
	loadSettings,
	rewriteJsonStrings,
	rewriteSystemPromptTools,
	rewriteToolResultContent,
	type Settings,
} from './config.ts';
import { isRecord, isSubagent, isPwsh, type ToolSnapshot } from './contributions.ts';
import {
	findSubagentsPackageRoot,
	getAgentFromCatalog,
	loadSubagentCatalog,
	type SubagentCatalog,
} from './subagentCatalog.ts';
import {
	reconcileChildEnvironments,
	resolveCurrentChangePiPromptPath,
	type ReconciliationResult,
} from './childReconciliation.ts';
import {
	defaultShellProbeHost,
	hideUnavailableShellTools,
	parseShellPathFromSettings,
	probeShellAvailability,
	type ShellProbeHost,
} from './shellAvailability.ts';
import { transformSystemPrompt } from './transform.ts';

export function isStandalonePiExecutable(execPath: string = process.execPath): boolean {
	const name = basename(execPath);
	return /^pi(?:\.exe)?$/i.test(name);
}

export interface PromptExtensionOptions {
	probeHost?: ShellProbeHost;
	isStandalone?: () => boolean;
	changePiPromptPath?: string;
}

export const CHILD_TOOL_MARKER_START = '<!-- change-pi-prompt:child-tools:v1 -->';
export const CHILD_TOOL_MARKER_END = '<!-- /change-pi-prompt:child-tools:v1 -->';

export function isChildSession(systemPrompt: string, options?: { customPrompt?: string }): boolean {
	if (/<active_agent\s+name=["'][^"']+["']\s*\/?>/i.test(systemPrompt)) return true;
	if (systemPrompt.includes(CHILD_TOOL_MARKER_START)) return true;
	if (typeof options?.customPrompt === 'string' && options.customPrompt.length > 0) return true;
	return false;
}

export function buildChildToolEnvironmentBlock(activeTools: readonly string[]): string {
	const hasBash = activeTools.includes('bash');
	const hasPowerShell = activeTools.includes('powershell');

	const lines = [
		CHILD_TOOL_MARKER_START,
		'## Child Tool Environment',
		'- Available tools are authoritative; do not call tools that are not active.',
	];

	if (hasBash) {
		lines.push('- `bash` currently uses the runtime described by its tool description.');
	}
	if (hasPowerShell) {
		lines.push('- `powershell` is available.');
	}
	if (!hasBash && !hasPowerShell) {
		lines.push('- No shell tool is available; use read/grep/find/ls/edit/write instead.');
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

	const probeHost: ShellProbeHost = options.probeHost ?? defaultShellProbeHost();
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

	function promptExtensionEnabled(): boolean {
		return settings ? settings.config.enabled === true : true;
	}

	function subagentAdaptationEnabled(): boolean {
		return settings ? (settings.config.enabled === true && settings.config.subagent === true) : true;
	}

	const updateConfirmedSubagentTools = () => {
		confirmedSubagentToolNames.clear();
		for (const tool of snapshotTools(pi)) {
			if (isSubagent(tool)) {
				confirmedSubagentToolNames.add(tool.name);
			}
		}
	};

	const runReconciliation = () => {
		if (!subagentAdaptationEnabled()) return;
		try {
			const tools = snapshotTools(pi);
			const pkgRoot = findSubagentsPackageRoot(tools);
			catalog = loadSubagentCatalog(pkgRoot);
			reconciliationResult = reconcileChildEnvironments({
				agentDir,
				catalog,
				parentTools: tools,
				changePiPromptPath,
			});
			for (const [name, status] of reconciliationResult.compatibilityStatus) {
				if (!status.ok) {
					lastStatus.push(`child-compat: ${name} missing [${status.missingTools.join(', ')}]`);
				}
			}
		} catch (error) {
			lastStatus.push(`child-reconciliation-error: ${errorSummary(error)}`);
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
	const reload = async () => {
		// Assign only after the whole snapshot validates, retaining last-good settings on errors.
		settings = await loadSettings(agentDir);
		if (subagentAdaptationEnabled()) {
			runReconciliation();
		}
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

	/** Hide bash/powershell with no backend before the model sees the catalog.
	 *  Run on session_start and again on before_agent_start so later setActiveTools (plan-mode, /reload) cannot resurrect a missing shell. */
	const pruneUnavailableShells = async (ctx: ExtensionContext): Promise<string[] | undefined> => {
		if (!promptExtensionEnabled() || !settings?.config.pruneUnavailableShells) return undefined;
		if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') return undefined;
		const availability = probeShellAvailability(probeHost, await readConfiguredShellPath());
		lastShellStatus = [`shell: bash=${availability.bash ? 'available' : 'missing'}, powershell=${availability.powershell ? 'available' : 'missing'}`];
		const active = [...pi.getActiveTools()];
		const { next, hidden } = hideUnavailableShellTools(active, availability, { keepBash: snapshotTools(pi).some(isPwsh) });
		if (hidden.length === 0) return next;
		pi.setActiveTools(next);
		lastShellStatus.push(`shell-tools: hid ${hidden.join(', ')}`);
		for (const name of hidden) {
			warnOnce(ctx, `${name} 后端不可用，已对本会话隐藏该工具并省略对应提示。`);
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
		await ensureLoaded(ctx);
		if (!promptExtensionEnabled()) return;
		await pruneUnavailableShells(ctx);
		if (subagentAdaptationEnabled()) {
			runReconciliation();
		}
		if (lastShellStatus.length) lastStatus = [...lastStatus, ...lastShellStatus];
	});

	pi.on('session_shutdown', async () => {
		lastPreview = undefined;
		warned.clear();
		contributionHashes.clear();
		confirmedSubagentToolNames.clear();
	});

	pi.on('before_agent_start', async (event, ctx) => {
		await ensureLoaded(ctx);
		if (!promptExtensionEnabled()) return;
		try {
			updateConfirmedSubagentTools();
			const pruned = await pruneUnavailableShells(ctx);
			const tools = snapshotTools(pi);
			const activeTools = pruned
				?? (typeof pi.getActiveTools === 'function'
					? [...pi.getActiveTools()] : [...(event.systemPromptOptions?.selectedTools ?? [])]);

			// Child session: do not replace role prompt or transform into "You are Pi"; only inject tool compatibility
			if (isChildSession(event.systemPrompt, event.systemPromptOptions)) {
				const nextPrompt = injectChildToolEnvironment(event.systemPrompt, activeTools);
				lastStatus = ['child-subagent-mode: preserved role prompt, injected tool environment', ...lastShellStatus];
				if (nextPrompt !== event.systemPrompt) {
					return { systemPrompt: nextPrompt };
				}
				return;
			}

			// Parent session: full prompt transformation
			const nativeTools = tools.filter(tool => activeTools.includes(tool.name) && isSubagent(tool));
			const standalone = isStandalone();
			const nativeAsync = (subagentAdaptationEnabled() && standalone && nativeTools.length)
				? await inspectNativeSubagentAsyncDefault(agentDir)
				: undefined;

			const rewritten = subagentAdaptationEnabled()
				? rewriteSystemPromptTools(event.systemPrompt, nativeTools, { standalone })
				: { systemPrompt: event.systemPrompt, rewritten: [] };

			const result = transformSystemPrompt({
				systemPrompt: rewritten.systemPrompt,
				options: event.systemPromptOptions,
				tools, activeTools,
				...settings!,
				hostOs: hostOs(), today: localDate(),
			});
			lastStatus = [...result.diagnostics, ...lastShellStatus];
			if (nativeAsync) {
				lastStatus.push(nativeAsync.message);
				if (!nativeAsync.ok) warnOnce(ctx, nativeAsync.message);
			}
			if (rewritten.rewritten.length) lastStatus.push(`rewrote upstream async default in: ${rewritten.rewritten.join(', ')}`);
			for (const tool of tools.filter(tool => activeTools.includes(tool.name) && (isPwsh(tool) || isSubagent(tool)))) {
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
		if (confirmedSubagentToolNames.size === 0) {
			updateConfirmedSubagentTools();
		}
		if (!confirmedSubagentToolNames.has(event.toolName)) return;

		const input = (isRecord(event.input) ? event.input : undefined) as Record<string, unknown> | undefined;
		if (!input) return;

		// Management action: not an execution call (e.g. action: 'list' | 'status' | 'guide')
		if (typeof input.action === 'string' && input.action.trim().length > 0) {
			return;
		}

		if (!catalog || !reconciliationResult) {
			runReconciliation();
		}

		const standalone = isStandalone();
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

		// Native direct agent: verify required tool providers
		if (targetAgentName && reconciliationResult) {
			const compat = reconciliationResult.compatibilityStatus.get(targetAgentName);
			if (compat && !compat.ok) {
				return {
					block: true,
					reason: `[change-pi-prompt] Agent "${targetAgentName}" requires ${compat.missingTools.join(', ')}, but no child-loadable provider was found for that active tool.`,
				};
			}
			if (reconciliationResult.incompatibleAgents.includes(targetAgentName)) {
				return {
					block: true,
					reason: `[change-pi-prompt] Agent "${targetAgentName}" has subagentOnlyExtensions disabled in settings.json, preventing child tool environment reconciliation.`,
				};
			}
		}

		// Workflow script: validate bounded async:true in standalone
		if (standalone && typeof input.workflowScript === 'string') {
			if (hasExplicitAsyncTrueInScript(input.workflowScript)) {
				return {
					block: true,
					reason: '[change-pi-prompt] standalone Pi 环境不支持在 workflowScript 内部调用中使用 async:true。请移除 async:true 或改为 async:false。',
				};
			}
		}

		// Standalone native child: enforce foreground execution
		if (standalone) {
			const check = await inspectNativeSubagentAsyncDefault(agentDir);
			if (!check.ok) {
				return {
					block: true,
					reason: `[change-pi-prompt] 阻止 subagent 调用：独立 Pi 环境要求 asyncByDefault=false 且 forceTopLevelAsync!=true。请检查 ${check.path}。（${check.message}）`,
				};
			}
			input.async = false;
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
						report(ctx, `${created ? '已创建' : '保留已有'} ${join(agentDir, 'subagent-tool-description.md')}。请在 ${join(agentDir, 'extensions', 'subagent', 'config.json')} 顶层设置 toolDescriptionMode 为 custom，并设置 asyncByDefault 为 false，随后开启新会话。项目配置目录中的 subagent-tool-description.md 优先；本命令不修改 pi-subagents 配置。上游会自动追加安全指南。独立二进制环境必须显式关闭后台子 agent。`);
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
