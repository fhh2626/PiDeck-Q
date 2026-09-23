/**
 * 安全策略纯函数（src/main/security/policy.ts）
 *
 * 主进程侧的规则求值/校验，供 SecurityStore、IPC 校验与单测使用。
 * pi-deck-security-gate 扩展内有一份自包含的等价实现（扩展不允许 import 本项目源码），
 * 两者以 SecurityPolicySnapshot 为契约：本模块负责「生成快照 + 校验快照」，
 * 扩展负责「按快照拦截」。
 */

import { win32, posix } from "node:path";
import type {
	SecurityAction,
	SecurityConfig,
	SecurityLevelConfig,
	SecurityPolicySnapshot,
} from "../../shared/types/security";

/**
 * 敏感路径模式（本地副本，与 shared/types/security.ts 的 DEFAULT_SENSITIVE_PATH_PATTERNS
 * 及扩展内置列表对齐；保持无运行时依赖，便于 node --test 直接 import 本模块）。
 */
const SENSITIVE_PATH_PATTERNS: string[] = [
	"(^|[\\\\/])\\.env([.$]|$)",
	"(^|[\\\\/])\\.git([\\\\/]|$)",
	"(^|[\\\\/])(id_rsa|id_ed25519|id_ecdsa)(\\.pub)?$",
	"(^|[\\\\/])\\.(npmrc|yarnrc|pnpm-workspace)([.$]|$)",
	"(\\.pem|\\.key|\\.p12)$",
];

/**
 * 默认 PowerShell 危险命令模式（本地副本，与 shared/types/security.ts 对齐）
 */
const DEFAULT_DENY_POWERSHELL_PATTERNS: string[] = [
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
	"\\b(winget|choco|scoop|dotnet|cargo|go)\\s+(install|add|remove|uninstall|update|upgrade|publish)\\b",
	"\\b(cmd|pwsh|powershell)(?:\\.exe)?\\s+.*(?:\\/c|\\/k|-command|-encodedcommand)\\b",
];

export type SecurityPathFlavor = "win32" | "posix";

function getPathModule(flavor?: SecurityPathFlavor) {
	if (flavor === "win32") return win32;
	if (flavor === "posix") return posix;
	const activePlatform = typeof process !== "undefined" && process?.platform ? process.platform : "win32";
	return activePlatform === "win32" ? win32 : posix;
}

function getActiveFlavor(flavor?: SecurityPathFlavor): SecurityPathFlavor {
	if (flavor) return flavor;
	const activePlatform = typeof process !== "undefined" && process?.platform ? process.platform : "win32";
	return activePlatform === "win32" ? "win32" : "posix";
}

/**
 * 规范化并基于 cwd 解析路径。
 * 遇到空路径、NUL 字节、Windows 命名空间路径、裸盘符/盘符相对路径、无明确盘符的根相对路径时返回 null。
 */
export function resolvePolicyPath(
	input: string | undefined | null,
	cwd: string | undefined | null,
	flavor?: SecurityPathFlavor,
): string | null {
	if (typeof input !== "string" || !input || input.includes("\0")) return null;
	const pathMod = getPathModule(flavor);
	const activeFlavor = getActiveFlavor(flavor);

	if (activeFlavor === "win32") {
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

	if (activeFlavor === "win32") {
		const slashCwd = cwd.replace(/\\/g, "/");
		if (slashCwd.startsWith("//?/") || slashCwd.startsWith("//./")) return null;
		if (/^[a-zA-Z]:/.test(slashCwd) && !/^[a-zA-Z]:\//.test(slashCwd)) return null;
		if (slashCwd.startsWith("/") && !/^\/\/[^/]+\/[^/]+(?:\/|$)/.test(slashCwd)) return null;
	}

	return pathMod.resolve(cwd, input);
}

/** 路径分隔符归一化：Windows 反斜杠 → 正斜杠，便于统一比较 */
export function normalizePathForCompare(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** 判断 target 是否位于 root 目录之内（含等于）。Windows 忽略盘符大小写。 */
export function isPathInsideRoot(
	target: string,
	root: string,
	flavor?: SecurityPathFlavor,
): boolean {
	if (!target || !root) return false;
	const pathMod = getPathModule(flavor);
	const activeFlavor = getActiveFlavor(flavor);

	// 统一经由 resolvePolicyPath 校验（若输入为不合法/不确定形式则拒绝）
	const normTarget = pathMod.isAbsolute(target) ? resolvePolicyPath(target, undefined, activeFlavor) : null;
	const normRoot = pathMod.isAbsolute(root) ? resolvePolicyPath(root, undefined, activeFlavor) : null;
	if (!normTarget || !normRoot) return false;

	const rel = pathMod.relative(normRoot, normTarget);
	if (rel === "") return true;
	if (rel === ".." || rel.startsWith(".." + pathMod.sep)) return false;
	if (pathMod.isAbsolute(rel)) return false;

	if (activeFlavor === "win32") {
		// Windows 检查大小写无关，且盘符必须匹配
		const targetDrive = pathMod.parse(normTarget).root.toLowerCase();
		const rootDrive = pathMod.parse(normRoot).root.toLowerCase();
		if (targetDrive !== rootDrive) return false;
		// 如果 relative 包含了 ..（大小写不同时可能被误判），二次校验
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

/**
 * 判断文件路径是否命中敏感文件规则。
 * 匹配规则是「文件名模式」：允许匹配完整路径任意一段（如 .env、.git 目录、密钥文件）。
 */
export function matchesSensitivePath(filePath: string): boolean {
	const normalized = normalizePathForCompare(filePath);
	return SENSITIVE_PATH_PATTERNS.some((pattern) => {
		try {
			return new RegExp(pattern).test(normalized);
		} catch {
			return false;
		}
	});
}

/**
 * 解析某会话实际生效的等级 id：
 * 会话级覆盖优先，其次全局默认，兜底内置 standard（配置损坏时保证可用）。
 */
export function resolveLevelId(config: SecurityConfig, sessionId?: string): string {
	const override = sessionId ? config.sessionOverrides[sessionId] : undefined;
	if (override) return override;
	if (config.defaultLevelId) return config.defaultLevelId;
	return "standard";
}

/** 按 id 取等级配置；找不到时回退 standard，仍无则取第一个等级（极端损坏兜底）。 */
export function resolveLevel(
	config: SecurityConfig,
	levelId: string,
): SecurityLevelConfig {
	const found = config.levels.find((level) => level.id === levelId);
	if (found) return found;
	const standard = config.levels.find((level) => level.id === "standard");
	return standard ?? config.levels[0];
}

/**
 * 校验安全配置，返回错误信息列表（空数组 = 合法）。
 * 校验点：等级 id 唯一、默认等级存在、工具动作表键合法、危险命令正则可编译。
 */
/**
 * 校验安全配置，返回错误信息列表（空数组 = 合法）。
 * 校验点与扩展快照校验对齐：等级 id 唯一且非空、等级对象有效、默认等级存在、
 * 工具动作表键/值合法、危险命令正则可编译、路径策略/默认动作/布尔项类型合法、
 * 目录列表合法且无 NUL、会话覆盖引用存在。
 */
export function validateSecurityConfig(config: unknown): string[] {
	const errors: string[] = [];
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		errors.push("配置必须是非空对象");
		return errors;
	}
	const cfg = config as Record<string, unknown>;

	if (typeof cfg.enabled !== "boolean") {
		errors.push("enabled 必须是 boolean");
	}

	if (!Array.isArray(cfg.levels) || cfg.levels.length === 0) {
		errors.push("levels 不能为空");
		return errors;
	}

	const seen = new Set<string>();
	for (const item of cfg.levels) {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			errors.push("level 项必须是非空对象");
			continue;
		}
		const level = item as Record<string, unknown>;

		if (typeof level.id !== "string" || !level.id.trim() || seen.has(level.id)) {
			errors.push(`等级 id 重复或为空: ${level.id ?? "(空)"}`);
		} else {
			seen.add(level.id);
		}

		if (typeof level.name !== "string" || typeof level.description !== "string") {
			errors.push(`等级 ${level.id ?? "(未知)"} 名称或描述必须为字符串`);
		}

		if (level.builtin !== undefined && typeof level.builtin !== "boolean") {
			errors.push(`等级 ${level.id ?? "(未知)"} builtin 必须是 boolean`);
		}
		if (level.builtin && level.id !== "off" && level.id !== "standard" && level.id !== "strict") {
			errors.push(`内置等级 id 非法: ${level.id}`);
		}

		if (level.defaultAction !== "allow" && level.defaultAction !== "ask" && level.defaultAction !== "deny") {
			errors.push(`等级 ${level.id ?? "(未知)"} defaultAction 非法: ${level.defaultAction}`);
		}

		if (level.pathPolicy !== "unrestricted" && level.pathPolicy !== "workspace" && level.pathPolicy !== "custom") {
			errors.push(`等级 ${level.id ?? "(未知)"} pathPolicy 非法: ${level.pathPolicy}`);
		}

		if (typeof level.protectSensitivePaths !== "boolean") {
			errors.push(`等级 ${level.id ?? "(未知)"} protectSensitivePaths 必须是 boolean`);
		}

		if (!level.toolActions || typeof level.toolActions !== "object" || Array.isArray(level.toolActions)) {
			errors.push(`等级 ${level.id ?? "(未知)"} toolActions 必须是对象`);
		} else {
			for (const [tool, action] of Object.entries(level.toolActions as Record<string, unknown>)) {
				if (!["read", "write", "edit", "bash", "powershell", "grep", "find", "ls", "ask_question"].includes(tool)) {
					errors.push(`等级 ${level.id} 包含未知工具: ${tool}`);
				}
				if (action !== "allow" && action !== "ask" && action !== "deny") {
					errors.push(`等级 ${level.id} 工具 ${tool} 动作非法: ${action}`);
				}
			}
		}

		if (!Array.isArray(level.denyBashPatterns)) {
			errors.push(`等级 ${level.id ?? "(未知)"} denyBashPatterns 必须是数组`);
		} else {
			for (const pattern of level.denyBashPatterns) {
				if (typeof pattern !== "string") {
					errors.push(`等级 ${level.id} 危险命令模式必须是字符串`);
					continue;
				}
				try {
					new RegExp(pattern);
				} catch {
					errors.push(`等级 ${level.id} 危险命令正则无法编译: ${pattern}`);
				}
			}
		}

		if (level.denyPowerShellPatterns !== undefined) {
			if (!Array.isArray(level.denyPowerShellPatterns)) {
				errors.push(`等级 ${level.id ?? "(未知)"} denyPowerShellPatterns 必须是数组`);
			} else {
				for (const pattern of level.denyPowerShellPatterns) {
					if (typeof pattern !== "string") {
						errors.push(`等级 ${level.id} PowerShell 危险命令模式必须是字符串`);
						continue;
					}
					try {
						new RegExp(pattern, "i");
					} catch {
						errors.push(`等级 ${level.id} PowerShell 危险命令正则无法编译: ${pattern}`);
					}
				}
			}
		}

		if (!Array.isArray(level.customAllowDirs)) {
			errors.push(`等级 ${level.id ?? "(未知)"} customAllowDirs 必须是数组`);
		} else {
			for (const dir of level.customAllowDirs) {
				if (typeof dir !== "string" || !dir.trim() || dir.includes("\0")) {
					errors.push(`等级 ${level.id} customAllowDirs 包含非法目录: ${dir}`);
				}
			}
		}

		if (!Array.isArray(level.denyDirs)) {
			errors.push(`等级 ${level.id ?? "(未知)"} denyDirs 必须是数组`);
		} else {
			for (const dir of level.denyDirs) {
				if (typeof dir !== "string" || !dir.trim() || dir.includes("\0")) {
					errors.push(`等级 ${level.id} denyDirs 包含非法目录: ${dir}`);
				}
			}
		}
	}

	if (!cfg.defaultLevelId || typeof cfg.defaultLevelId !== "string" || !seen.has(cfg.defaultLevelId)) {
		errors.push(`默认等级不存在: ${cfg.defaultLevelId ?? "(空)"}`);
	}

	if (cfg.sessionOverrides !== undefined) {
		if (!cfg.sessionOverrides || typeof cfg.sessionOverrides !== "object" || Array.isArray(cfg.sessionOverrides)) {
			errors.push("sessionOverrides 必须是对象");
		} else {
			for (const [sId, lId] of Object.entries(cfg.sessionOverrides as Record<string, unknown>)) {
				if (typeof sId !== "string" || typeof lId !== "string" || !lId.trim() || !seen.has(lId)) {
					errors.push(`会话覆盖 ${sId} 指向不存在或非法的等级: ${lId}`);
				}
			}
		}
	}

	return errors;
}

/** 生成扩展消费的策略快照（写入 userData/security-policy.json）。 */
export function buildSnapshot(config: SecurityConfig): SecurityPolicySnapshot {
	return {
		schemaVersion: 1,
		enabled: config.enabled,
		defaultLevelId: resolveLevelId(config),
		levels: config.levels,
		sessionLevels: config.sessionOverrides,
	};
}

/**
 * 求值 bash 命令：命中危险模式 → 返回命中动作（denyBash 逻辑由调用方组合）；
 * 返回 null 表示未命中任何危险模式。
 */
export function matchBashDenyPatterns(
	level: SecurityLevelConfig,
	command: string,
): string | null {
	for (const pattern of level.denyBashPatterns) {
		try {
			if (new RegExp(pattern).test(command)) return pattern;
		} catch {
			// 非法正则已在校验阶段拦截；这里静默跳过保证扩展不因配置崩溃
		}
	}
	return null;
}

/**
 * 求值 powershell 命令：命中危险模式 → 返回命中规则模式；未命中返回 null。
 */
export function matchPowerShellDenyPatterns(
	level: SecurityLevelConfig,
	command: string,
): string | null {
	const patterns = level.denyPowerShellPatterns ?? DEFAULT_DENY_POWERSHELL_PATTERNS;
	for (const pattern of patterns) {
		try {
			if (new RegExp(pattern, "i").test(command)) return pattern;
		} catch {
			// 静默跳过
		}
	}
	return null;
}

/** 求值文件访问动作：黑名单、敏感文件或目录边界外的访问均拒绝；否则 null，由工具动作决定。 */
export function evaluatePathAction(
	level: SecurityLevelConfig,
	filePath: string,
	cwd: string,
	flavor?: SecurityPathFlavor,
): SecurityAction | null {
	const resolvedTarget = resolvePolicyPath(filePath, cwd, flavor);
	if (!resolvedTarget) return "deny";

	for (const rawDir of level.denyDirs) {
		const resolvedDenyDir = resolvePolicyPath(rawDir, cwd, flavor);
		if (resolvedDenyDir && isPathInsideRoot(resolvedTarget, resolvedDenyDir, flavor)) return "deny";
	}
	if (level.protectSensitivePaths && matchesSensitivePath(resolvedTarget)) return "deny";
	if (level.pathPolicy === "unrestricted") return null;
	// workspace / custom：允许工作目录本身；custom 额外允许自定义目录
	const resolvedCwd = resolvePolicyPath(cwd, cwd, flavor);
	if (resolvedCwd && isPathInsideRoot(resolvedTarget, resolvedCwd, flavor)) return null;
	if (level.pathPolicy === "custom") {
		for (const rawDir of level.customAllowDirs) {
			const resolvedAllowDir = resolvePolicyPath(rawDir, cwd, flavor);
			if (resolvedAllowDir && isPathInsideRoot(resolvedTarget, resolvedAllowDir, flavor)) return null;
		}
	}
	return "deny";
}
