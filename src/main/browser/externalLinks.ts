import type { AppLogger } from "../logging/AppLogger";

/**
 * 外部链接安全网关：只允许受控协议交给系统处理器。
 *
 * 抽成纯策略（依赖注入）以便单测覆盖协议与错误语义；
 * Electron shell 细节留在 index.ts 装配处。
 */

/**
 * 解析 URL 的 scheme（统一小写，含冒号）；无法解析返回 null。
 *
 * 用 WHATWG URL 解析而不是字符串前缀：HTTP:/MAILTO: 等大写 scheme、以及
 * 渲染层拼出的各种畸形输入都能得到一致的判定结果。
 */
export function getUrlScheme(url: string): string | null {
	try {
		return new URL(url).protocol.toLowerCase();
	} catch {
		return null;
	}
}

/** 判断 URL 是否为 web 协议（scheme 大小写不敏感）。 */
export function isHttpLikeExternalUrl(url: string): boolean {
	const scheme = getUrlScheme(url);
	return scheme === "http:" || scheme === "https:";
}

/**
 * 允许交给系统处理器的非 web 协议白名单（应用内受信 UI 触发，如设置页/更新流程）。
 *
 * 渲染层传来的 URL 属于不可信输入（IPC 边界必须校验）：不能把任意 scheme 全量
 * 放行给操作系统（file:/search-ms:/ms-* 等系统协议可能触发本机处理程序），
 * 因此除 http(s) 外只放行通信类 / 编码工具类深链；白名单外的请求保持忽略但记
 * warn 日志，行为可观测而不是静默丢弃。
 */
export const NON_HTTP_EXTERNAL_SCHEMES: readonly string[] = [
	"mailto:",
	"tel:",
	"sms:",
	"vscode:",
	"vscode-insiders:",
];

/** 是否为允许离开应用的 URL（web 协议或受信 UI 白名单内的系统协议）。 */
export function isAllowedSystemExternalProtocol(url: string): boolean {
	const scheme = getUrlScheme(url);
	if (scheme == null) return false;
	if (scheme === "http:" || scheme === "https:") return true;
	return NON_HTTP_EXTERNAL_SCHEMES.includes(scheme);
}

export type OpenExternalLinkDeps = {
	/** 系统默认处理方式打开（shell.openExternal 的注入点）。 */
	openInSystem: (url: string) => Promise<void>;
	/** 非致命失败记录（协议被拒 / 非 http(s) 打开失败只降级记日志，不上抛）。 */
	logger?: Pick<AppLogger, "warn">;
};

/**
 * 外部 URL 统一入口（唯一协议网关）。
 *
 * HTTP(S) 打开失败原样上抛，供更新等调用方感知故障；白名单内的非 HTTP
 * 协议打开失败只记 warn，因为系统缺少对应处理器是常见环境状态；其他协议拒绝。
 */
export async function openExternalLink(url: string, deps: OpenExternalLinkDeps): Promise<void> {
	if (!isAllowedSystemExternalProtocol(url)) {
		deps.logger?.warn(
			"browser",
			"Rejected external link with non-allowlisted protocol",
			{ url },
		);
		return;
	}

	if (!isHttpLikeExternalUrl(url)) {
		try {
			await deps.openInSystem(url);
		} catch (error) {
			deps.logger?.warn(
				"browser",
				"Failed to open non-http external link",
				{ url, error },
			);
		}
		return;
	}

	await deps.openInSystem(url);
}
