/**
 * PiDeck Security Gate Extension
 *
 * 安全门执行器：按桌面端写入的策略快照（PIDECK_SECURITY_CONFIG 指向的 JSON）
 * 在 tool_call 事件上执行拦截/确认。
 *
 * 设计约束：
 * - 本文件必须自包含：只能依赖 @earendil-works/pi-coding-agent 与 node 内置模块，
 *   不允许 import PiDeck 源码（扩展在 pi 进程内加载，不共享打包产物）。
 * - 与主进程的契约 = 策略快照 schema（src/shared/types/security.ts 的
 *   SecurityPolicySnapshot）。schemaVersion 不匹配时本扩展保守降级：fail-safe 放行
 *   还是拒绝由配置语义决定——enabled=false 放行；快照不可读时放行并记日志。
 * - 运行时热更新：每次 tool_call 前 stat 快照文件，mtime 变化即重读（带节流），
 *   因此输入框切换会话等级无需重启 agent 即可生效。
 *
 * 动作语义（与主进程 policy.ts 保持一致）：
 * - 工具动作：level.toolActions[tool] ?? level.defaultAction
 * - shell 工具按真实执行后端选择 Bash / PowerShell 策略；child 兼容槽即使公开名为 bash，
 *   只要真实后端是 PowerShell，就使用 powershell action 与 denyPowerShellPatterns。
 * - 文件访问：denyDirs 黑名单 > 敏感文件保护 > pathPolicy 目录边界，命中即拒绝。
 * - 只管控受支持的工具名（read/write/edit/bash/powershell/grep/find/ls/ask_question），
 *   其它自定义工具（web_search/todo 等）不受影响，避免破坏用户其它扩展。
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

// ── 快照 schema（与 shared/types/security.ts 对齐；扩展侧自包含副本） ──

type SecurityAction = "allow" | "ask" | "deny";
type SecurityPathPolicy = "unrestricted" | "workspace" | "custom";
type ShellTool = "bash" | "powershell";

type SecurityLevelConfig = {
	id: string;
	name: string;
	description: string;
	builtin?: boolean;
	toolActions: Partial<Record<string, SecurityAction>>;
	denyBashPatterns: string[];
	denyPowerShellPatterns?: string[];
	pathPolicy: SecurityPathPolicy;
	customAllowDirs: string[];
	denyDirs: string[];
	protectSensitivePaths: boolean;
	defaultAction: SecurityAction;
};

type SecurityPolicySnapshot = {
	schemaVersion: number;
	enabled: boolean;
	defaultLevelId: string;
	levels: SecurityLevelConfig[];
	sessionLevels: Record<string, string>;
};

// ── 常量 ──

const SCHEMA_VERSION = 1;
const PWSH_ADAPTER_PACKAGE = "@99percentpeople/pi-pwsh-adapter";
/** 受管控的工具名（其它自定义工具一律放行） */
const MANAGED_TOOLS = new Set([
	"read",
	"write",
	"edit",
	"bash",
	"powershell",
	"grep",
	"find",
	"ls",
	"ask_question",
]);
/** 默认危险 PowerShell 命令模式（Windows cmdlet 与别名） */
const DEFAULT_POWERSHELL_DENY_PATTERNS = [
	"\\b(Remove-Item|rm|del|erase|rmdir)\\b",
	"\\b(Set-Content|Add-Content|Clear-Content|Out-File)\\b",
	"\\b(New-Item|mkdir|ni)\\b",
	"\\b(Move-Item|mv|Copy-Item|cp|Rename-Item)\\b",
	"\\b(Set-Item|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Set-Acl)\\b",
	"\\b(Invoke-Expression|Start-Process|Stop-Process)\\b",
	"(^|[^<])>(?!>)",
	">>",
	"\\bgit\\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|branch\\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)\\b",
	"\\bnpm\\s+(install|uninstall|update|ci|publish)\\b",
	"\\bpnpm\\s+(add|install|remove|update|publish)\\b",
	"\\byarn\\s+(add|install|remove|publish)\\b",
];
/** 敏感路径模式（与主进程 DEFAULT_SENSITIVE_PATH_PATTERNS 对齐） */
const SENSITIVE_PATH_PATTERNS = [
	"(^|[\\\\/])\\.env([.$]|$)",
	"(^|[\\\\/])\\.git([\\\\/]|$)",
	"(^|[\\\\/])(id_rsa|id_ed25519|id_ecdsa)(\\.pub)?$",
	"(^|[\\\\/])\\.(npmrc|yarnrc|pnpm-workspace)([.$]|$)",
	"(\\.pem|\\.key|\\.p12)$",
];

// ── 快照加载（带 mtime 热更新） ──

let snapshot: SecurityPolicySnapshot | null = null;
let snapshotPath = "";
let sessionId = "";
let lastLoadedAt = 0;
let lastLoadedMtime = 0;
/** 节流窗口：快照文件小，stat 每 2s 最多一次，避免高频工具调用时反复读盘 */
const RELOAD_THROTTLE_MS = 2000;

/**
 * 加载策略快照：
 * - 2s 内且 mtime 未变 → 用缓存（每次 tool_call 只做一次 stat）；
 * - mtime 变化 → 立即重读（会话等级切换 ≤2s 生效）；
 * - 文件缺失 / schema 不匹配 / 解析失败 → 返回 null（调用方按 fail-safe 处理）。
 */
function loadSnapshot(targetPath = snapshotPath): SecurityPolicySnapshot | null {
	const now = Date.now();
	try {
		if (!targetPath || !existsSync(targetPath)) {
			snapshot = null;
			return null;
		}
		const mtime = statSync(targetPath).mtimeMs;
		if (snapshot && mtime === lastLoadedMtime && now - lastLoadedAt < RELOAD_THROTTLE_MS) {
			return snapshot;
		}
		lastLoadedAt = now;
		lastLoadedMtime = mtime;
		const raw = readFileSync(targetPath, "utf8");
		const parsed = JSON.parse(raw) as SecurityPolicySnapshot;
		if (parsed.schemaVersion !== SCHEMA_VERSION) {
			// schema 升级：旧快照不再可信，fail-safe 放行（配置语义由主进程迁移保证）
			snapshot = null;
			return null;
		}
		snapshot = parsed;
		return snapshot;
	} catch {
		snapshot = null;
		return null;
	}
}

// ── 纯规则求值（与主进程 src/main/security/policy.ts 语义一致） ──

function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isPathInsideRoot(target: string, root: string): boolean {
	const t = normalizePath(target).toLowerCase();
	const r = normalizePath(root).toLowerCase();
	if (!r || r === "/") return true;
	if (t === r) return true;
	return t.startsWith(r + "/");
}

function matchesSensitivePath(filePath: string): boolean {
	const normalized = normalizePath(filePath);
	return SENSITIVE_PATH_PATTERNS.some((pattern) => {
		try {
			return new RegExp(pattern).test(normalized);
		} catch {
			return false;
		}
	});
}

function resolveLevel(config: SecurityPolicySnapshot, levelId: string): SecurityLevelConfig | null {
	return (
		config.levels.find((level) => level.id === levelId) ??
		config.levels.find((level) => level.id === "standard") ??
		config.levels[0] ??
		null
	);
}

/** 文件访问边界求值：命中黑名单/敏感/越界 → deny；否则 null（交给工具动作决定） */
function evaluatePathAction(
	level: SecurityLevelConfig,
	filePath: string,
	cwd: string,
): SecurityAction | null {
	for (const dir of level.denyDirs) {
		if (isPathInsideRoot(filePath, dir)) return "deny";
	}
	if (level.protectSensitivePaths && matchesSensitivePath(filePath)) return "deny";
	if (level.pathPolicy === "unrestricted") return null;
	if (cwd && isPathInsideRoot(filePath, cwd)) return null;
	if (level.pathPolicy === "custom") {
		for (const dir of level.customAllowDirs) {
			if (isPathInsideRoot(filePath, dir)) return null;
		}
	}
	return "deny";
}

/** bash 危险命令求值：命中返回 true（动作组合见 filePolicy 注释 / 下方 shellAction） */
function matchesBashDeny(level: SecurityLevelConfig, command: string): boolean {
	return level.denyBashPatterns.some((pattern) => {
		try {
			return new RegExp(pattern).test(command);
		} catch {
			return false;
		}
	});
}

/** powershell 危险命令求值：命中返回 true */
function matchesPowerShellDeny(level: SecurityLevelConfig, command: string): boolean {
	const patterns = level.denyPowerShellPatterns ?? DEFAULT_POWERSHELL_DENY_PATTERNS;
	return patterns.some((pattern) => {
		try {
			return new RegExp(pattern, "i").test(command);
		} catch {
			return false;
		}
	});
}

/** 计算 shell (bash / powershell) 命令最终动作 */
function shellAction(
	level: SecurityLevelConfig,
	tool: ShellTool,
	command: string,
): SecurityAction {
	const dangerous = tool === "powershell"
		? matchesPowerShellDeny(level, command)
		: matchesBashDeny(level, command);
	const toolAction = level.toolActions[tool] ?? level.defaultAction;
	if (!dangerous) return toolAction;
	// 危险命令：显式放行该 shell → 放行；严格兜底(deny) → 直接拒绝；其余 → 先确认
	if (toolAction === "allow") return "allow";
	if (level.defaultAction === "deny") return "deny";
	return "ask";
}

/**
 * Resolve the shell policy by execution backend rather than the public tool name.
 * pi-pwsh-adapter occupies the public `bash` name while executing PowerShell.
 */
export function resolveSecurityShellTool(pi: ExtensionAPI, tool: ShellTool): ShellTool {
	if (tool !== "bash" || typeof pi.getAllTools !== "function") return tool;
	const bash = pi.getAllTools().find((candidate) => candidate.name === "bash");
	if (!bash) return tool;
	const source = bash.sourceInfo?.source ?? "";
	if (source === `npm:${PWSH_ADAPTER_PACKAGE}` || source.startsWith(`npm:${PWSH_ADAPTER_PACKAGE}@`)) {
		return "powershell";
	}
	const providerPath = (bash.sourceInfo?.path ?? "").replace(/\\/g, "/");
	if (providerPath.includes(`/node_modules/${PWSH_ADAPTER_PACKAGE}/`)) {
		return "powershell";
	}
	return tool;
}

/** 计算文件工具最终动作：路径边界优先，其次工具动作 */
function fileToolAction(
	level: SecurityLevelConfig,
	tool: string,
	filePath: string | undefined,
	cwd: string,
): SecurityAction {
	if (filePath) {
		const pathAction = evaluatePathAction(level, filePath, cwd);
		if (pathAction) return pathAction;
	}
	return level.toolActions[tool] ?? level.defaultAction;
}

/** 从工具入参中提取文件路径（read/write/edit 有路径字段；grep/find/ls 可选 path） */
function extractFilePath(tool: string, input: Record<string, unknown>): string | undefined {
	switch (tool) {
		case "read":
			return typeof input.path === "string" ? input.path : undefined;
		case "write":
		case "edit":
			if (typeof input.path === "string") return input.path;
			if (typeof input.filePath === "string") return input.filePath;
			return undefined;
		case "grep":
		case "find":
		case "ls":
			return typeof input.path === "string" ? input.path : undefined;
		default:
			return undefined;
	}
}

/** 绝对路径化：相对路径基于 cwd 解析（与 pi 工具语义一致） */
function absolutize(p: string, cwd: string): string {
	if (isAbsolute(p)) return p;
	return resolve(cwd, p);
}

// ── UI 确认 ──

const UI_ALLOW = "允许执行";
const UI_DENY = "拒绝";

/**
 * 弹窗确认。RPC 模式下取消/无 UI 一律拒绝（fail-safe）。
 * 返回 true = 放行。
 */
async function confirmAction(
	ctx: ExtensionContext,
	title: string,
	detail: string,
	levelName: string,
): Promise<boolean> {
	if (!ctx.hasUI) return false;
	try {
		const choice = await ctx.ui.select(`${title}\n${detail}\n\n[等级: ${levelName}]`, [
			UI_ALLOW,
			UI_DENY,
		]);
		return choice === UI_ALLOW;
	} catch {
		// UI 通道异常（如桌面端已关闭弹窗）→ 拒绝，宁可错杀不可放过
		return false;
	}
}

// ── 系统提示注入：让 agent 提前知道边界，减少无效尝试 ──

function buildSecurityHint(level: SecurityLevelConfig): string | undefined {
	if (level.id === "off") return undefined;
	const lines: string[] = [
		"当前会话启用了桌面端安全管理（等级: " + level.name + "）。",
	];
	if (level.pathPolicy === "workspace" || level.pathPolicy === "custom") {
		lines.push("文件读写仅限工作目录" + (level.pathPolicy === "custom" ? "及显式允许的目录" : "") + "，工作目录之外的文件访问会被拒绝。");
	}
	if (level.denyBashPatterns.length > 0 || (level.denyPowerShellPatterns ?? DEFAULT_POWERSHELL_DENY_PATTERNS).length > 0) {
		lines.push("部分危险 shell 命令会被拦截或要求用户确认。");
	}
	if (level.protectSensitivePaths) {
		lines.push(".env / .git / 密钥文件等敏感路径受保护，读写会被拒绝。");
	}
	return lines.join("\n");
}

// ── 入口 ──

export default async function securityGateExtension(pi: ExtensionAPI) {
	// Bundled child sessions inherit the parent PiDeck security policy.
	// Security must be enforced on child tools themselves; gating only the
	// parent `subagent` call would not protect edit/write/bash inside the child.
	const currentSnapshotPath = process.env.PIDECK_SECURITY_CONFIG ?? snapshotPath;
	const currentSessionId = process.env.PIDECK_SESSION_ID ?? sessionId;
	snapshotPath = currentSnapshotPath;
	sessionId = currentSessionId;

	if (!currentSnapshotPath) {
		// 桌面端未注入配置路径（旧版本 PiDeck / 独立 CLI 运行）：完全放行
		return;
	}

	pi.on("before_agent_start", (_event, ctx) => {
		const config = loadSnapshot(currentSnapshotPath);
		if (!config?.enabled) return undefined;
		const levelId = config.sessionLevels[currentSessionId] ?? config.defaultLevelId;
		const level = resolveLevel(config, levelId);
		if (!level) return undefined;
		const hint = buildSecurityHint(level);
		if (!hint) return undefined;
		return { systemPrompt: (ctx.getSystemPrompt?.() ?? "") + "\n\n" + hint };
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		// 热更新：快照 mtime 变化即重读（≤2s），会话等级切换无需重启
		const config = loadSnapshot(currentSnapshotPath);
		if (!config?.enabled) return undefined;

		const tool = event.toolName;
		// 只管控受支持的工具名；其它自定义工具（web_search/todo/vision 等）放行
		if (!MANAGED_TOOLS.has(tool)) return undefined;

		const levelId = config.sessionLevels[currentSessionId] ?? config.defaultLevelId;
		const level = resolveLevel(config, levelId);
		if (!level || level.id === "off") return undefined;

		const input = event.input as Record<string, unknown>;
		let action: SecurityAction;
		let semanticShellTool: ShellTool | undefined;

		if (tool === "bash" || tool === "powershell") {
			const command = typeof input.command === "string" ? input.command : "";
			semanticShellTool = resolveSecurityShellTool(pi, tool);
			action = shellAction(level, semanticShellTool, command);
		} else {
			const filePath = extractFilePath(tool, input);
			action = fileToolAction(
				level,
				tool,
				filePath ? absolutize(filePath, ctx.cwd) : undefined,
				ctx.cwd,
			);
		}

		if (action === "allow") return undefined;

		const target = (tool === "bash" || tool === "powershell")
			? (typeof input.command === "string" ? input.command.slice(0, 200) : "")
			: (typeof input.path === "string" || typeof input.filePath === "string"
				? String(input.path ?? input.filePath)
				: "");
		const displayTool = tool === "bash" && semanticShellTool === "powershell"
			? "powershell (bash compatibility slot)"
			: tool;

		if (action === "deny") {
			return {
				block: true,
				reason: `[安全管理·${level.name}] ${displayTool} 调用被拒绝${target ? `: ${target}` : ""}`,
			};
		}

		// action === "ask"：弹窗确认
		const allowed = await confirmAction(
			ctx,
			`PiDeck 安全确认：允许 ${displayTool} 调用吗？`,
			target.slice(0, 500),
			level.name,
		);
		if (allowed) return undefined;
		return {
			block: true,
			reason: `[安全管理·${level.name}] ${displayTool} 调用已被用户拒绝${target ? `: ${target}` : ""}`,
		};
	});
}
