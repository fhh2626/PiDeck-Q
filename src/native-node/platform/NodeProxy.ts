import { ProxyAgent, type Dispatcher } from "undici";
import type { PlatformProxy, PlatformProxyConfig } from "../../main/platform/PlatformServices";

type NativeFetch = (
	input: string | URL,
	init?: RequestInit & { dispatcher?: Dispatcher },
) => Promise<Response>;

/** Node-side desktop proxy adapter; unlike Electron it never touches WebView traffic. */
export class NodeProxy implements PlatformProxy {
	private config: PlatformProxyConfig = { mode: "direct" };
	private agent: ProxyAgent | null = null;
	private readonly nativeFetch: NativeFetch = globalThis.fetch as unknown as NativeFetch;

	async apply(config: PlatformProxyConfig): Promise<void> {
		this.config = config;
		this.agent?.close();
		this.agent = config.mode === "fixed_servers"
			? new ProxyAgent(config.proxyRules)
			: null;
	}

	fetch = (
		input: Parameters<typeof globalThis.fetch>[0],
		init?: Parameters<typeof globalThis.fetch>[1],
	): Promise<Response> => {
		const target = input instanceof Request ? input.url : String(input);
		const url = new URL(target);
		const dispatcher = this.shouldBypass(url.hostname) ? undefined : this.agent ?? undefined;
		const requestInit: RequestInit & { dispatcher?: Dispatcher } = dispatcher
			? { ...init, dispatcher }
			: { ...init };
		return this.nativeFetch(target, requestInit);
	};

	private shouldBypass(hostname: string): boolean {
		if (this.config.mode !== "fixed_servers" || !this.config.proxyBypassRules) return false;
		const rules = this.config.proxyBypassRules.split(/[;,\s]+/).map((rule) => rule.trim()).filter(Boolean);
		return rules.some((rule) => {
			const normalized = rule.replace(/^\*\./, "").toLowerCase();
			return normalized === "<local>"
				? !hostname.includes(".")
				: hostname.toLowerCase() === normalized || hostname.toLowerCase().endsWith(`.${normalized}`);
		});
	}
}
