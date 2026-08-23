import type { AppSettings } from "../../shared/types";
import { getAppLogger } from "../logging/sharedLogger";
import type { PlatformProxy } from "../platform/PlatformServices";

type DesktopProxySettings = Pick<
	AppSettings,
	"desktopProxyEnabled" | "desktopProxyUrl" | "desktopProxyBypass"
>;

export async function applyDesktopProxy(
	settings: DesktopProxySettings,
	platformProxy: PlatformProxy,
) {
	const config = buildDesktopProxyConfig(settings);
	try {
		await platformProxy.apply(config);
		// 桌面代理属全局网络配置：只记 mode，不记 proxyRules（URL 可能内嵌凭据）
		void getAppLogger()?.info("settings", "Desktop proxy applied", { mode: config.mode });
	} catch (error) {
		void getAppLogger()?.error("settings", "Desktop proxy apply failed", {
			mode: config.mode,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

export function buildDesktopProxyConfig(settings: DesktopProxySettings) {
	if (!settings.desktopProxyEnabled) return { mode: "direct" as const };

	const proxyRules = normalizeProxyRules(settings.desktopProxyUrl);
	if (!proxyRules) return { mode: "direct" as const };

	return {
		mode: "fixed_servers" as const,
		proxyRules,
		proxyBypassRules: normalizeBypassRules(settings.desktopProxyBypass),
	};
}

function normalizeProxyRules(value: string) {
	const trimmed = value.trim();
	if (!trimmed) return "";
	const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
		? trimmed
		: `http://${trimmed}`;

	try {
		const url = new URL(normalized);
		if (!url.hostname) return "";
		return url.href.replace(/\/$/, "");
	} catch {
		return "";
	}
}

function normalizeBypassRules(value: string) {
	return value
		.split(/[,\n;]/)
		.map((item) => item.trim())
		.filter(Boolean)
		.join(";");
}
