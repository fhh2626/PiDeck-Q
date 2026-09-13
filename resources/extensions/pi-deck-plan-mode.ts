/**
 * PiDeck Plan Mode Extension
 *
 * 为 PiDeck 桌面输入框提供“Plan”发送模式：用户可见消息保持原文，
 * renderer 会在 agentMessage 中加入隐藏标记，本扩展在 pi input 事件里识别后
 * 临时切换为只读工具集，并要求 agent 输出 `Plan:` 编号计划。
 *
 * 生成计划后，扩展通过 RPC Extension UI Protocol 弹出执行/停留/修改选择；
 * 选择执行时恢复写工具，并用 [DONE:n] 标记驱动进度 widget。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PI_DECK_PLAN_MODE_MARKER = "__PI_DECK_PLAN_MODE__";

// Plan 模式禁止直接写工具和 subagent。
// subagent 可能拥有自己的 edit/write/bash，因此不能在只读规划阶段继续暴露。
const PLAN_MODE_BASE_TOOLS = ["read", "ask_question"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>([
	"edit",
	"write",
	"subagent",
]);

interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

interface PlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	toolsBeforePlanMode?: string[];
}

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bkill\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*ps\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

export const POWERSHELL_DESTRUCTIVE_PATTERNS = [
	/\b(Remove-Item|rm|del|erase|rmdir|ri)\b/i,
	/\b(Set-Content|sc)\b/i,
	/\b(Add-Content|ac)\b/i,
	/\b(Clear-Content|clc)\b/i,
	/\bOut-File\b/i,
	/\b(New-Item|ni|mkdir|md)\b/i,
	/\b(Copy-Item|cp|cpi|copy)\b/i,
	/\b(Move-Item|mv|mi|move)\b/i,
	/\b(Rename-Item|rni|ren)\b/i,
	/\b(Set-Item|si)\b/i,
	/\b(Set-ItemProperty|sp)\b/i,
	/\b(New-ItemProperty|Remove-ItemProperty|Clear-ItemProperty|Clear-Item)\b/i,
	/\bSet-Acl\b/i,
	/\b(Invoke-Expression|iex)\b/i,
	/\b(Invoke-Command|icm)\b/i,
	/\b(Start-Process|saps)\b/i,
	/\b(Stop-Process|spps|kill)\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)\b/i,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)\b/i,
	/\byarn\s+(add|remove|install|publish)\b/i,
	/\bpnpm\s+(add|remove|install|publish)\b/i,
	/\bpip\s+(install|uninstall)\b/i,
];

export const POWERSHELL_SAFE_PATTERNS = [
	/^\s*(Get-Content|gc|cat|type)\b/i,
	/^\s*(Get-ChildItem|gci|ls|dir)\b/i,
	/^\s*(Select-String|sls)\b/i,
	/^\s*(Get-Location|gl|pwd)\b/i,
	/^\s*(Write-Output|echo)\b/i,
	/^\s*Write-Host\b/i,
	/^\s*(Measure-Object|measure)\b/i,
	/^\s*(Sort-Object|sort)\b/i,
	/^\s*(Select-Object|select)\b/i,
	/^\s*(Where-Object|where|\?)\b/i,
	/^\s*(ForEach-Object|%)\b/i,
	/^\s*(Get-Command|gcm)\b/i,
	/^\s*(Get-Help|help|man)\b/i,
	/^\s*(Get-Item|gi)\b/i,
	/^\s*(Get-ItemProperty|gp)\b/i,
	/^\s*Test-Path\b/i,
	/^\s*(Compare-Object|diff)\b/i,
	/^\s*(Format-Table|ft)\b/i,
	/^\s*(Format-List|fl)\b/i,
	/^\s*(Format-Wide|fw)\b/i,
	/^\s*(Out-String|Out-Host|Out-Null|Out-Default)\b/i,
	/^\s*(Get-Process|gps|ps)\b/i,
	/^\s*Get-Date\b/i,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*jq\b/i,
	/^\s*rg\b/i,
	/^\s*fd\b/i,
	/^\s*bat\b/i,
];

export function isSafePowerShellCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;

	// 1. 全局破坏性检查（命令任意位置命中破坏性模式均拦截）
	if (POWERSHELL_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
		return false;
	}

	// 2. 管道与复合命令切分（| ; &&）
	const segments = trimmed
		.split(/[|;&]+/)
		.map((segment) => segment.trim())
		.filter(Boolean);

	if (segments.length === 0) return false;

	for (const segment of segments) {
		if (POWERSHELL_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(segment))) {
			return false;
		}
		if (!POWERSHELL_SAFE_PATTERNS.some((pattern) => pattern.test(segment))) {
			return false;
		}
	}

	return true;
}

export function isSafeCommand(command: string): boolean {
	return !DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command)) &&
		SAFE_PATTERNS.some((pattern) => pattern.test(command));
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length > 0) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	return cleaned.length > 64 ? `${cleaned.slice(0, 61)}...` : cleaned;
}

function extractTodoItems(message: string): TodoItem[] {
	// 兼容 Plan: / **Plan:** / 中文「计划：」；不要求标题后必须立刻换行。
	const headerMatch = message.match(/(?:\*{0,2}Plan:\*{0,2}|计划[:：])\s*/i);
	if (!headerMatch || headerMatch.index === undefined) return [];

	const items: TodoItem[] = [];
	const planSection = message.slice(headerMatch.index + headerMatch[0].length);
	// 支持 1. / 1) / 1、 / 1:；整行再 clean，避免加粗步骤被截断。
	const numberedPattern = /^\s*(\d+)[.)、:]\s+(.+)$/gm;
	for (const match of planSection.matchAll(numberedPattern)) {
		const cleaned = cleanStepText(match[2] ?? "");
		if (cleaned.length > 3 && !cleaned.startsWith("/")) {
			items.push({ step: items.length + 1, text: cleaned, completed: false });
		}
	}
	return items;
}

function markCompletedSteps(text: string, items: TodoItem[]): number {
	let changed = 0;
	for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		const item = items.find((candidate) => candidate.step === step);
		if (item && !item.completed) {
			item.completed = true;
			changed += 1;
		}
	}
	return changed;
}

export function uniqueToolNames(toolNames: string[]): string[] {
	return [...new Set(toolNames)];
}

export function getPlanModeTools(activeToolNames: string[]): string[] {
	const tools: string[] = [];
	for (const tool of activeToolNames) {
		if (!PLAN_MODE_DISABLED_TOOLS.has(tool)) {
			tools.push(tool);
		}
	}
	for (const base of PLAN_MODE_BASE_TOOLS) {
		if (!tools.includes(base)) {
			tools.push(base);
		}
	}
	return uniqueToolNames(tools);
}

export function getNormalModeTools(activeToolNames: string[]): string[] {
	const tools = [...activeToolNames];
	for (const writeTool of ["edit", "write"]) {
		if (!tools.includes(writeTool)) {
			tools.push(writeTool);
		}
	}
	return uniqueToolNames(tools);
}

export default function piDeckPlanModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let toolsBeforePlanMode: string[] | undefined;

	function updateWidget(ctx: ExtensionContext): void {
		// 规划阶段生成 Plan 后就应显示；以前只在 executionMode 才 setWidget，
		// 导致用户选「继续只读/关闭弹框」时 Plan 分区永远空白。
		if (todoItems.length === 0) {
			ctx.ui.setWidget("pi-deck-plan-todos", undefined);
			return;
		}
		const completed = todoItems.filter((item) => item.completed).length;
		const title = executionMode
			? `计划进度 ${completed}/${todoItems.length}`
			: `计划草案 ${todoItems.length} 步`;
		ctx.ui.setWidget("pi-deck-plan-todos", [
			title,
			...todoItems.map((item) => `${item.completed ? "☑" : "☐"} ${item.step}. ${item.text}`),
		]);
	}

	function persistState(): void {
		pi.appendEntry("pi-deck-plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			toolsBeforePlanMode,
		});
	}

	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) toolsBeforePlanMode = pi.getActiveTools();
		pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
	}

	function restoreNormalModeTools(): void {
		pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
		toolsBeforePlanMode = undefined;
	}

	function setPlanMode(ctx: ExtensionContext, enabled: boolean): void {
		planModeEnabled = enabled;
		executionMode = false;
		todoItems = [];
		if (enabled) {
			enablePlanModeTools();
			ctx.ui.notify("PiDeck 计划模式已启用。启用期间只能执行只读命令，不能修改文件。", "info");
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("PiDeck 计划模式已禁用。已恢复写权限。", "info");
		}
		updateWidget(ctx);
		persistState();
	}

	pi.registerCommand("plan", {
		description: "切换 PiDeck 计划模式（只读探索，适用于复杂任务先做分析）",
		handler: async (args, ctx) => {
			const normalized = String(args ?? "").trim().toLowerCase();
			if (["on", "enable", "enabled"].includes(normalized)) setPlanMode(ctx, true);
			else if (["off", "disable", "disabled", "normal"].includes(normalized)) setPlanMode(ctx, false);
			else setPlanMode(ctx, !planModeEnabled);
		},
	});

	pi.registerCommand("todos", {
		description: "查看当前计划进度",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("没有活跃的计划事项。", "info");
				return;
			}
			ctx.ui.notify(
				todoItems.map((item) => `${item.step}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n"),
				"info",
			);
		},
	});

	pi.on("input", async (event, ctx) => {
		if (!event.text.startsWith(PI_DECK_PLAN_MODE_MARKER)) {
			// 用户发了一条普通消息（无 plan 标记）：若仍处于 plan 模式且非执行中，
			// 视为退出 plan——composer 切回 normal 发消息即退出只读模式。
			// pi-desktop RPC 模式下 /plan 命令不路由，这里作为会话内退出的兜底。
			if (planModeEnabled && !executionMode) {
				setPlanMode(ctx, false);
			}
			return;
		}

		// 由桌面输入框模式触发：隐藏标记只用于路由，必须在进入 LLM 前剥离。
		planModeEnabled = true;
		executionMode = false;
		todoItems = [];
		enablePlanModeTools();
		updateWidget(ctx);
		persistState();
		return {
			action: "transform" as const,
			text: event.text.slice(PI_DECK_PLAN_MODE_MARKER.length).replace(/^\s+/, ""),
		};
	});

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;
		if (event.toolName === "bash") {
			const command = String(event.input.command ?? "");
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `PiDeck Plan Mode blocked a non-read-only command. Choose Execute after plan confirmation to allow writes.\nCommand: ${command}`,
				};
			}
		} else if (event.toolName === "powershell") {
			const command = String(event.input.command ?? "");
			if (!isSafePowerShellCommand(command)) {
				return {
					block: true,
					reason: `PiDeck Plan Mode blocked a non-read-only command. Choose Execute after plan confirmation to allow writes.\nCommand: ${command}`,
				};
			}
		}
	});

	pi.on("context", async (event) => {
		if (planModeEnabled || executionMode) return;
		return {
			messages: event.messages.filter((message) => {
				const typed = message as AgentMessage & { customType?: string };
				// Plan/execution prompts are transient mode instructions; when the mode ends, keep them out of future context.
				return ![
					"pi-deck-plan-mode-context",
					"pi-deck-plan-execution-context",
				].includes(String(typed.customType ?? ""));
			}),
		};
	});

	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			const active = pi.getActiveTools();
			const hasBash = active.includes("bash");
			const hasPwsh = active.includes("powershell");
			let shellRule = "";
			if (hasBash && hasPwsh) {
				shellRule = "- Shell commands (bash/powershell) are restricted to read-only commands.\n";
			} else if (hasBash) {
				shellRule = "- Bash is restricted to read-only commands.\n";
			} else if (hasPwsh) {
				shellRule = "- PowerShell is restricted to read-only commands.\n";
			}
			return {
				message: {
					customType: "pi-deck-plan-mode-context",
					content: `[PLAN MODE ACTIVE]\nYou are in PiDeck Plan Mode.\n\nRules:\n- Only inspect and reason. Do not edit or write files.\n${shellRule}- Ask the user with ask_question when a requirement is ambiguous.\n- End your response with a numbered plan under an exact \"Plan:\" heading.\n\nPlan:\n1. First concrete step\n2. Second concrete step`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((item) => !item.completed);
			return {
				message: {
					customType: "pi-deck-plan-execution-context",
					content: `[EXECUTING PI_DECK PLAN]\nExecute remaining steps in order. After completing a step, include [DONE:n] in your response.\n\n${remaining.map((item) => `${item.step}. ${item.text}`).join("\n")}`,
					display: false,
				},
			};
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;
		if (markCompletedSteps(getTextContent(event.message), todoItems) > 0) {
			updateWidget(ctx);
			persistState();
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((item) => item.completed)) {
				pi.sendMessage(
					{
						customType: "pi-deck-plan-complete",
						content: `**PiDeck Plan Complete** ✓\n\n${todoItems.map((item) => `- ${item.text}`).join("\n")}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				updateWidget(ctx);
				persistState();
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) todoItems = extractTodoItems(getTextContent(lastAssistant));
		if (todoItems.length === 0) return;
		// 先推 Plan 分区，再弹后续选择；用户无论选执行/继续/关闭都能在输入框上方看到草案。
		updateWidget(ctx);
		persistState();

		const todoListText = todoItems.map((item) => `${item.step}. ☐ ${item.text}`).join("\n");
		// 循环展示选单：取消「修改计划」时回到选单，避免用户误点后 agent 空停。
		// 标题前缀 [PI_DECK_PLAN_NEXT] 给桌面端识别：关闭=退出计划模式，不是「默认第一项」。
		// 标题前缀 [PI_DECK_PLAN_NEXT]：桌面端识别后换专用 UI/取消提示。
		// 选项用「标题|说明」编码，桌面端拆成主副文案；前缀仍用于 startsWith 匹配。
		const PLAN_NEXT_TITLE =
			"[PI_DECK_PLAN_NEXT] 计划草案已就绪（" + todoItems.length + " 步）";
		const PLAN_OPT_EXECUTE = "开始执行|恢复写权限，按步骤改代码并勾进度";
		// 「先不执行」只结束本轮、保持只读；不会自动再分析，需用户再发消息。
		const PLAN_OPT_CONTINUE = "先不执行|结束本轮，保持只读；再发消息后 AI 才继续";
		const PLAN_OPT_REVISE = "修改计划|写下修改意见，重新出一版计划";
		let actionTaken = false;
		while (!actionTaken) {
			const choice = await ctx.ui.select(PLAN_NEXT_TITLE, [
				PLAN_OPT_EXECUTE,
				PLAN_OPT_CONTINUE,
				PLAN_OPT_REVISE,
			]);

			if (choice?.startsWith("开始执行")) {
				planModeEnabled = false;
				executionMode = true;
				restoreNormalModeTools();
				updateWidget(ctx);
				persistState();
				pi.sendMessage(
					{ customType: "pi-deck-plan-todos", content: `**Plan Steps (${todoItems.length})**\n\n${todoListText}`, display: true },
					{ deliverAs: "followUp" },
				);
				pi.sendMessage(
					{
						customType: "pi-deck-plan-execute",
						content: `Execute the approved plan.\n\n${todoItems.map((item) => `${item.step}. ${item.text}`).join("\n")}\n\nAfter completing a step, include [DONE:n].`,
						display: true,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				actionTaken = true;
			} else if (choice?.startsWith("修改计划")) {
				// 标题前缀 [PI_DECK_PLAN_REVISE]：桌面端显示「返回上一步」而不是误当成退出计划。
				// 取消/空内容 → refinement 为 undefined/空，循环回到三选一，不会退出 plan。
				const refinement = await ctx.ui.editor(
					"[PI_DECK_PLAN_REVISE] 写下你想怎么改这份计划（可返回重选）",
					"",
				);
				if (refinement?.trim()) {
					pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
					actionTaken = true;
				}
				// 取消或空内容 → 不设 actionTaken，while 循环重新弹出三选一
			} else if (choice?.startsWith("先不执行") || choice?.startsWith("继续规划")) {
				// 结束本轮、保持 plan 只读；不 triggerTurn，用户再发消息才会继续
				actionTaken = true;
			} else {
				// 关闭选单（X / Esc）→ 退出 plan 模式；不会默认选「开始执行」
				setPlanMode(ctx, false);
				actionTaken = true;
			}
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const planModeEntry = entries
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "pi-deck-plan-mode")
			.pop() as { data?: PlanModeState } | undefined;
		if (planModeEntry?.data) {
			// plan 模式不跨会话恢复：新会话默认 normal，避免用户被锁在只读模式无法写入。
			// 仅 execution（正在执行已确认计划）和 todos 跨会话续接。
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
		}
		planModeEnabled = false;
		updateWidget(ctx);
	});
}
