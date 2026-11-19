/** Lifecycle for the optional original Pi base-prompt optimizer. */
import os from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { initializeSettings, loadSettings, type Settings } from './config.ts';
import { isRecord, type ToolSnapshot } from './contributions.ts';
import { OWN_END, OWN_START, stripChildDocumentation, transformSystemPrompt } from './transform.ts';

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

/** Snapshot host-owned metadata without mutating tools or their extension guidance. */
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

function errorSummary(error: unknown): string {
	if (isRecord(error) && typeof error.code === 'string') return `I/O error ${error.code}`;
	return error instanceof Error ? error.message : 'Unknown extension error';
}

/** Optional loader-scoped identity keeps this package independent of the subagent installation. */
function isNativeChildLoader(pi: ExtensionAPI): boolean {
	let child = false;
	pi.events?.emit('pideck-subagents:child-loader-query', { accept: () => { child = true; } });
	return child;
}

/** Register only prompt transformation and explicit configuration commands. */
export function registerPromptExtension(pi: ExtensionAPI, agentDir: string): void {
	// Native children answer on their own loader bus, including before a role tag exists.
	// The process marker remains supported for separate child processes.
	const childFlag = process.env.PI_SUBAGENT_CHILD;
	const childInstance = (childFlag !== undefined && childFlag !== '' && childFlag !== '0' && childFlag !== 'false') || isNativeChildLoader(pi);
	let settings: Settings | undefined;
	let loading: Promise<void> | undefined;
	let lastStatus = ['尚未转换提示词'];
	let lastPreview: string | undefined;
	const warned = new Set<string>();
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
	const reload = async () => { settings = await loadSettings(agentDir); };
	const ensureLoaded = async (ctx: ExtensionContext) => {
		loading ??= reload().catch(error => {
			warnOnce(ctx, `配置加载失败；${settings ? '保留上次有效配置' : '暂不改写提示词'}：${errorSummary(error)}`);
		});
		await loading;
	};

	pi.on('session_start', async (_event, ctx) => {
		warned.clear();
		lastPreview = undefined;
		lastStatus = ['尚未转换提示词'];
		await ensureLoaded(ctx);
	});
	pi.on('session_shutdown', async () => {
		lastPreview = undefined;
		warned.clear();
	});
	pi.on('before_agent_start', async (event, ctx) => {
		await ensureLoaded(ctx);
		if (!settings?.config.enabled) return;
		try {
			// A child's role remains owned by subagents. Only Pi's stock documentation is removable.
			if (childInstance || /<active_agent\s+name=["'][^"']+["']\s*\/?>/i.test(event.systemPrompt)) {
				const next = stripChildDocumentation(event.systemPrompt, settings.config, event.systemPromptOptions);
				if (next !== event.systemPrompt) return { systemPrompt: next };
				return;
			}
			const tools = snapshotTools(pi);
			const hasActiveApi = typeof pi.getActiveTools === 'function';
			const activeTools = hasActiveApi ? [...pi.getActiveTools()] : tools.map(tool => tool.name);
			const result = transformSystemPrompt({
				systemPrompt: event.systemPrompt,
				options: event.systemPromptOptions,
				tools,
				activeTools,
				config: hasActiveApi ? settings.config : { ...settings.config, pruneUnavailableShells: false, pruneUnavailableSearchTools: false },
				prompts: settings.prompts,
				hostOs: hostOs(), today: localDate(),
			});
			lastStatus = result.diagnostics;
			const end = result.systemPrompt.indexOf(OWN_END);
			lastPreview = result.systemPrompt.startsWith(OWN_START) && end >= 0 && end < 128 * 1024
				? result.systemPrompt.slice(0, end + OWN_END.length) : undefined;
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

	pi.registerCommand('change-pi-prompt', {
		description: '提示词替换：status | reload | init | preview',
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
						report(ctx, '配置已重载；下一次用户请求生效。');
						break;
					case 'init': {
						const count = await initializeSettings(agentDir);
						report(ctx, `已创建 ${count} 个配置/模板文件，已有文件未覆盖。目录：${join(agentDir, 'change-pi-prompt')}。编辑后执行 /change-pi-prompt reload。`);
						break;
					}
					case 'preview':
						if (!ctx.hasUI || !lastPreview) report(ctx, '暂无可预览的已转换基础提示词，或当前环境不支持编辑器。');
						else await ctx.ui.editor('基础提示词预览（不保存，不含项目/技能上下文）', lastPreview);
						break;
					default:
						report(ctx, '用法：/change-pi-prompt status | reload | init | preview');
				}
			} catch (error) {
				report(ctx, `命令失败；已有有效配置保持不变：${errorSummary(error)}`, true);
			}
		},
	});
}
