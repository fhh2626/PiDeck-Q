import type { AppLogger } from "../logging/AppLogger";

/**
 * 外部链接路由策略：按协议 + linkOpenMode 决定去向。
 *
 * 抽成纯策略（依赖注入）以便单测覆盖协议网关与打开方式组合；
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

/** 判断 URL 是否为内置浏览器可导航的 web 协议（scheme 大小写不敏感）。 */
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

/**
 * guest 网页内容可触发的系统协议白名单（更窄）：只有通信类深链。
 * vscode: 等本机工具深链不允许由任意远程网页触发——它们仅供受信的应用内
 * UI 使用（见 NON_HTTP_EXTERNAL_SCHEMES），两份白名单刻意分开维护。
 */
export const GUEST_SYSTEM_SCHEMES: readonly string[] = ["mailto:", "tel:", "sms:"];

/** 是否为允许离开应用的 URL（web 协议或受信 UI 白名单内的系统协议）。 */
export function isAllowedSystemExternalProtocol(url: string): boolean {
	const scheme = getUrlScheme(url);
	if (scheme == null) return false;
	if (scheme === "http:" || scheme === "https:") return true;
	return NON_HTTP_EXTERNAL_SCHEMES.includes(scheme);
}

/** guest 页面内链接可转系统的非 web 协议（GUEST_SYSTEM_SCHEMES 判定）。 */
export function isAllowedGuestSystemProtocol(url: string): boolean {
	const scheme = getUrlScheme(url);
	if (scheme == null || !GUEST_SYSTEM_SCHEMES.includes(scheme)) return false;
	// 结构校验（按协议分别判定标准 opaque 形式）：
	// - 不得有 authority（host 非空，如 mailto://example.com/...）——
	//   这些协议没有 host 语义，authority 只会出现在构造的混淆 URI 中；
	// - 不得是空 authority 的 path-form（如 sms:///abc、tel:/123、mailto:///x）——
	//   标准形式的目标在 opaque path（pathname 不以 / 开头），path-form 同样
	//   只出现在构造的混淆 URI 中。
	try {
		const parsed = new URL(url);
		return parsed.host === "" && !parsed.pathname.startsWith("/");
	} catch {
		return false;
	}
}

export type OpenExternalLinkDeps = {
	/** 系统默认处理方式打开（shell.openExternal 的注入点）。 */
	openInSystem: (url: string) => Promise<void>;
	/** 内置浏览器面板打开（仅 http/https 且 linkOpenMode=internal 时使用）。 */
	openInBrowserPanel: (url: string) => void;
	/** 用户设置的链接打开方式（forceSystem 场景由装配层固定返回 "external"）。 */
	linkOpenMode: () => "external" | "internal";
	/** 非致命失败记录（协议被拒 / 非 http(s) 打开失败只降级记日志，不上抛）。 */
	logger?: Pick<AppLogger, "warn">;
};

/**
 * 外部 URL 统一入口（唯一协议网关）。
 *
 * 协议语义：
 * - http/https：受 linkOpenMode 影响（internal → 浏览器面板，否则系统）；
 *   打开失败原样上抛 —— 调用方（如更新下载流程）需要感知页面打不开的故障。
 * - 白名单内系统协议（mailto:/tel: 等）：交给系统默认处理器，打开失败不中断
 *   调用方只记 warn（系统无对应处理器是常见环境状态，不是调用方错误）。
 * - 白名单外协议：拒绝并记 warn，不再静默丢弃也不再放行到 OS。
 */
export async function openExternalLink(url: string, deps: OpenExternalLinkDeps): Promise<void> {
	if (!isAllowedSystemExternalProtocol(url)) {
		deps.logger?.warn("browser", "Rejected external link with non-allowlisted protocol", { url });
		return;
	}
	if (!isHttpLikeExternalUrl(url)) {
		try {
			await deps.openInSystem(url);
		} catch (error) {
			deps.logger?.warn("browser", "Failed to open non-http external link", { url, error });
		}
		return;
	}
	if (deps.linkOpenMode() === "internal") {
		deps.openInBrowserPanel(url);
		return;
	}
	await deps.openInSystem(url);
}
