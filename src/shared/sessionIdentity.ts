import type { SessionEnvironment, SessionSource, SessionSummary } from "./types";

export type SessionOriginInput = {
	source: SessionSource;
	environment: SessionEnvironment;
	filePath: string;
	wslDistro?: string;
	wslUser?: string;
	importedSourceId?: string;
};

export function canonicalizeSessionPath(
	filePath: string,
	environment: SessionEnvironment,
): string {
	const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
	return environment === "native" ? normalized.toLowerCase() : normalized;
}

export function getSessionEnvironment(
	summary: Pick<SessionSummary, "wsl">,
): SessionEnvironment {
	return summary.wsl ? "wsl" : "native";
}

export function getImportedSessionSourceId(
	summary: Pick<SessionSummary, "source" | "codexSessionId">,
): string | undefined {
	return summary.source === "codex" ? summary.codexSessionId : undefined;
}

export function buildSessionOriginKey(input: SessionOriginInput): string {
	const environmentKey = input.environment === "wsl"
		? `wsl:${input.wslDistro ?? "unknown"}:${input.wslUser ?? "unknown"}`
		: "native";
	const importedKey = input.importedSourceId
		? `:${encodeURIComponent(input.importedSourceId)}`
		: "";
	return [
		input.source,
		environmentKey,
		canonicalizeSessionPath(input.filePath, input.environment),
	].join(":") + importedKey;
}

export function buildSummaryOriginKey(
	summary: SessionSummary,
	options?: { wslDistro?: string; wslUser?: string },
): string {
	return buildSessionOriginKey({
		source: summary.source ?? "pi",
		environment: getSessionEnvironment(summary),
		filePath: summary.filePath,
		wslDistro: options?.wslDistro,
		wslUser: options?.wslUser,
		importedSourceId: getImportedSessionSourceId(summary),
	});
}

/** 判断路径是否为该环境下的绝对路径（纯字符串判断，不依赖 node:path）。 */
function isAbsolutePath(filePath: string, environment: SessionEnvironment): boolean {
	if (environment === "wsl") return filePath.startsWith("/");
	// native：盘符开头、根前缀（如 \\server\share 或 /rooted）。
	return (
		/^[A-Za-z]:[\\/]/.test(filePath) ||
		filePath.startsWith("/") ||
		filePath.startsWith("\\")
	);
}

/**
 * Windows 盘符路径 → WSL /mnt/<drive>/… 基址（仅覆盖 WslPaths.toWslLinuxPath 的盘符分支；
 * 已以 / 开头的路径原样返回，无法识别的路径原样返回由调用方兜底）。
 * 与原生后端的 WSL 路径转换保持同一语义。
 */
function windowsPathToWslBase(path: string): string {
	const drive = path.match(/^([A-Za-z]):(?:[\\/](.*))?$/);
	if (drive) {
		const suffix = drive[2]?.replace(/[\\/]+/g, "/") ?? "";
		return `/mnt/${drive[1].toLowerCase()}/${suffix}`;
	}
	return path.startsWith("/") ? path.replace(/[\\/]+/g, "/") : path;
}

/**
 * 将会话文件路径归一化为绝对路径（纯字符串实现，可在渲染层安全调用）。
 *
 * pi 的 sessionDir 可配置为相对 cwd 的路径（如项目 `.pi/settings.json` 中
 * `"sessionDir": ".pi/sessions"`），此时 get_state 返回的 sessionFile 也是相对路径。
 * 若原样写入 catalog，会与扫描器发现的绝对路径构成「同一文件两条记录」
 * （侧栏重复显示两个会话），且 rename/delete/read 等文件操作会落到错误位置。
 * 所有会话路径在进入 catalog / Agent 状态前都应经过本函数。
 *
 * WSL 环境按 Linux 路径语义处理：相对路径解析到 /mnt/<drive>/… 基址。
 */
export function toAbsoluteSessionPath(
	filePath: string,
	projectPath: string,
	environment: SessionEnvironment,
): string {
	if (isAbsolutePath(filePath, environment)) return filePath;
	const base = environment === "wsl" ? windowsPathToWslBase(projectPath) : projectPath;
	const joined = `${base.replace(/[\\/]+$/, "")}/${filePath.replace(/^[\\/]+/, "")}`;
	// native 统一反斜杠风格，与 node:path resolve 输出一致；WSL 保持正斜杠。
	return environment === "wsl" ? joined : joined.replace(/\//g, "\\");
}
