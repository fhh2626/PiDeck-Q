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
 *   SecurityPolicySnapshot）。配置路径未注入时兼容放行；已注入但快照不可读、
 *   schema 不兼容或结构非法时拒绝全部受管工具。enabled=false 也必须完整校验。
 * - 运行时热更新：每次 tool_call 重新读取并验证快照，不依赖 mtime 或共享缓存；
 *   因此策略恢复及会话等级变更无需重启 agent 即可生效。
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
import { existsSync, readFileSync } from "node:fs";
import { win32, posix } from "node:path";

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

export type SnapshotLoadResult =
	| { kind: "unconfigured" }
	| { kind: "ready"; snapshot: SecurityPolicySnapshot }
	| { kind: "unavailable"; reason: "read-failed" | "invalid-json" | "unsupported-schema" | "invalid-shape" };

/**
 * 校验快照结构，收窄类型。
 */
export function validateSnapshotShape(data: unknown): SecurityPolicySnapshot | null {
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	const obj = data as Record<string, unknown>;

	if (obj.schemaVersion !== SCHEMA_VERSION) return null;
	if (typeof obj.enabled !== "boolean") return null;
	if (typeof obj.defaultLevelId !== "string" || !obj.defaultLevelId.trim()) return null;
	if (!Array.isArray(obj.levels) || obj.levels.length === 0) return null;
	if (!obj.sessionLevels || typeof obj.sessionLevels !== "object" || Array.isArray(obj.sessionLevels)) return null;

	const seenIds = new Set<string>();
	const levels: SecurityLevelConfig[] = [];

	for (const item of obj.levels) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return null;
		const lvl = item as Record<string, unknown>;

		if (typeof lvl.id !== "string" || !lvl.id.trim() || seenIds.has(lvl.id)) return null;
		seenIds.add(lvl.id);

		if (typeof lvl.name !== "string" || typeof lvl.description !== "string") return null;
		if (lvl.builtin !== undefined && typeof lvl.builtin !== "boolean") return null;
		if (lvl.builtin && lvl.id !== "off" && lvl.id !== "standard" && lvl.id !== "strict") return null;

		if (!lvl.toolActions || typeof lvl.toolActions !== "object" || Array.isArray(lvl.toolActions)) return null;
		for (const [tool, action] of Object.entries(lvl.toolActions as Record<string, unknown>)) {
			if (!MANAGED_TOOLS.has(tool)) return null;
			if (action !== "allow" && action !== "ask" && action !== "deny") return null;
		}

		if (lvl.defaultAction !== "allow" && lvl.defaultAction !== "ask" && lvl.defaultAction !== "deny") return null;
		if (lvl.pathPolicy !== "unrestricted" && lvl.pathPolicy !== "workspace" && lvl.pathPolicy !== "custom") return null;
		if (typeof lvl.protectSensitivePaths !== "boolean") return null;

		if (!Array.isArray(lvl.denyBashPatterns)) return null;
		for (const pat of lvl.denyBashPatterns) {
			if (typeof pat !== "string") return null;
			try { new RegExp(pat); } catch { return null; }
		}

		if (lvl.denyPowerShellPatterns !== undefined) {
			if (!Array.isArray(lvl.denyPowerShellPatterns)) return null;
			for (const pat of lvl.denyPowerShellPatterns) {
				if (typeof pat !== "string") return null;
				try { new RegExp(pat, "i"); } catch { return null; }
			}
		}

		if (!Array.isArray(lvl.customAllowDirs)) return null;
		for (const dir of lvl.customAllowDirs) {
			if (typeof dir !== "string" || !dir.trim() || dir.includes("\0")) return null;
		}

		if (!Array.isArray(lvl.denyDirs)) return null;
		for (const dir of lvl.denyDirs) {
			if (typeof dir !== "string" || !dir.trim() || dir.includes("\0")) return null;
		}

		levels.push(item as SecurityLevelConfig);
	}

	// 校验默认等级必须存在于 levels 中
	if (!seenIds.has(obj.defaultLevelId)) return null;

	// 校验 sessionLevels 中的引用必须非空且引用有效等级
	for (const [sId, lId] of Object.entries(obj.sessionLevels as Record<string, unknown>)) {
		if (typeof sId !== "string" || typeof lId !== "string" || !lId.trim() || !seenIds.has(lId)) {
			return null;
		}
	}

	return {
		schemaVersion: SCHEMA_VERSION,
		enabled: obj.enabled,
		defaultLevelId: obj.defaultLevelId,
		levels,
		sessionLevels: obj.sessionLevels as Record<string, string>,
	};
}

/**
 * 每次调用读取快照并完成校验。
 */
export function loadSnapshot(targetPath: string): SnapshotLoadResult {
	if (!targetPath) return { kind: "unconfigured" };
	try {
		if (!existsSync(targetPath)) {
			return { kind: "unavailable", reason: "read-failed" };
		}
		const raw = readFileSync(targetPath, "utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { kind: "unavailable", reason: "invalid-json" };
		}

		if (!parsed || typeof parsed !== "object" || (parsed as Record<string, unknown>).schemaVersion !== SCHEMA_VERSION) {
			return { kind: "unavailable", reason: "unsupported-schema" };
		}

		const validated = validateSnapshotShape(parsed);
		if (!validated) {
			return { kind: "unavailable", reason: "invalid-shape" };
		}

		return { kind: "ready", snapshot: validated };
	} catch {
		return { kind: "unavailable", reason: "read-failed" };
	}
}

// ── 纯规则求值（与主进程 src/main/security/policy.ts 语义一致） ──

function getPathModule() {
	return process.platform === "win32" ? win32 : posix;
}

/** 规范化并基于 cwd 解析路径。非法或无法确定的路径返回 null。 */
function resolvePolicyPath(input: string | undefined | null, cwd: string | undefined | null): string | null {
	if (typeof input !== "string" || !input || input.includes("\0")) return null;
	const pathMod = getPathModule();

	if (process.platform === "win32") {
		const slashPath = input.replace(/\\/g, "/");
		// 1. Windows 设备命名空间 \\?\ 或 \\.\ 明确拒绝
		if (slashPath.startsWith("//?/") || slashPath.startsWith("//./")) {
			return null;
		}

		// 2. 盘符相关检查：拒绝裸盘符（如 C:）与盘符相对路径（如 C:foo）
		if (/^[a-zA-Z]:/.test(slashPath)) {
			if (!/^[a-zA-Z]:\//.test(slashPath)) {
				return null;
			}
		}

		// 3. 只有完整的 //server/share 才是 UNC；多个前导分隔符不能伪装成 UNC。
		if (slashPath.startsWith("/") && !/^\/\/[^/]+\/[^/]+(?:\/|$)/.test(slashPath)) {
			return null;
		}
	}

	if (pathMod.isAbsolute(input)) {
		return pathMod.normalize(input);
	}

	if (!cwd || typeof cwd !== "string" || cwd.includes("\0") || !pathMod.isAbsolute(cwd)) {
		return null;
	}

	if (process.platform === "win32") {
		const slashCwd = cwd.replace(/\\/g, "/");
		if (slashCwd.startsWith("//?/") || slashCwd.startsWith("//./")) return null;
		if (/^[a-zA-Z]:/.test(slashCwd) && !/^[a-zA-Z]:\//.test(slashCwd)) return null;
		if (slashCwd.startsWith("/") && !/^\/\/[^/]+\/[^/]+(?:\/|$)/.test(slashCwd)) return null;
	}

	return pathMod.resolve(cwd, input);
}

function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isPathInsideRoot(target: string, root: string): boolean {
	if (!target || !root) return false;
	const pathMod = getPathModule();
	const normTarget = pathMod.isAbsolute(target) ? resolvePolicyPath(target, undefined) : null;
	const normRoot = pathMod.isAbsolute(root) ? resolvePolicyPath(root, undefined) : null;
	if (!normTarget || !normRoot) return false;

	const rel = pathMod.relative(normRoot, normTarget);
	if (rel === "") return true;
	if (rel === ".." || rel.startsWith(".." + pathMod.sep)) return false;
	if (pathMod.isAbsolute(rel)) return false;

	if (process.platform === "win32") {
		const targetDrive = pathMod.parse(normTarget).root.toLowerCase();
		const rootDrive = pathMod.parse(normRoot).root.toLowerCase();
		if (targetDrive !== rootDrive) return false;
		const normTargetLower = normTarget.toLowerCase();
		const normRootLower = normRoot.toLowerCase();
		const relLower = pathMod.relative(normRootLower, normTargetLower);
		if (relLower === "" || (!relLower.startsWith(".." + pathMod.sep) && relLower !== ".." && !pathMod.isAbsolute(relLower))) {
			return true;
		}
		return false;
	}

	return true;
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
	const resolvedTarget = resolvePolicyPath(filePath, cwd);
	if (!resolvedTarget) return "deny";

	for (const rawDir of level.denyDirs) {
		const resolvedDenyDir = resolvePolicyPath(rawDir, cwd);
		if (resolvedDenyDir && isPathInsideRoot(resolvedTarget, resolvedDenyDir)) return "deny";
	}
	if (level.protectSensitivePaths && matchesSensitivePath(resolvedTarget)) return "deny";
	if (level.pathPolicy === "unrestricted") return null;
	const resolvedCwd = resolvePolicyPath(cwd, cwd);
	if (resolvedCwd && isPathInsideRoot(resolvedTarget, resolvedCwd)) return null;
	if (level.pathPolicy === "custom") {
		for (const rawDir of level.customAllowDirs) {
			const resolvedAllowDir = resolvePolicyPath(rawDir, cwd);
			if (resolvedAllowDir && isPathInsideRoot(resolvedTarget, resolvedAllowDir)) return null;
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
	if (filePath !== undefined) {
		const pathAction = evaluatePathAction(level, filePath, cwd);
		if (pathAction) return pathAction;
	} else if (tool === "read" || tool === "write" || tool === "edit") {
		// 必要路径字段缺失或非法，直接拒绝
		return "deny";
	} else if (tool === "grep" || tool === "find" || tool === "ls") {
		// grep/find/ls 未提供 path 时，以 cwd 为检查目标
		const pathAction = evaluatePathAction(level, cwd, cwd);
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
	// 每次 extension 注册时捕获独立的 env 变量，不继承前一个实例的值
	const instanceSnapshotPath = process.env.PIDECK_SECURITY_CONFIG ?? "";
	const instanceSessionId = process.env.PIDECK_SESSION_ID ?? "";

	pi.on("before_agent_start", (_event, ctx) => {
		if (!instanceSnapshotPath) return undefined;
		const result = loadSnapshot(instanceSnapshotPath);
		if (result.kind !== "ready" || !result.snapshot.enabled) return undefined;
		const config = result.snapshot;
		const levelId = config.sessionLevels[instanceSessionId] ?? config.defaultLevelId;
		const level = resolveLevel(config, levelId);
		if (!level) return undefined;
		const hint = buildSecurityHint(level);
		if (!hint) return undefined;
		return { systemPrompt: (ctx.getSystemPrompt?.() ?? "") + "\n\n" + hint };
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		const tool = event.toolName;
		// 只管控受支持的工具名；其它自定义工具（web_search/todo/vision 等）放行
		if (!MANAGED_TOOLS.has(tool)) return undefined;

		if (!instanceSnapshotPath) return undefined;

		const result = loadSnapshot(instanceSnapshotPath);
		if (result.kind === "unconfigured") return undefined;

		if (result.kind === "unavailable") {
			return {
				block: true,
				reason: `[SECURITY_POLICY_UNAVAILABLE] 安全策略不可用（${result.reason}），已阻止受管工具调用`,
			};
		}

		const config = result.snapshot;
		if (!config.enabled) return undefined;

		const levelId = config.sessionLevels[instanceSessionId] ?? config.defaultLevelId;
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
				filePath,
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
