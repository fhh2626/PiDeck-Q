import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/**
 * 加载真实的 initializeNativeDesktop（含真实 nativeReloadUrl），把 transport/window/fetch 换成替身，
 * 用来观察“断层重载 / 重载保留 token”这类导航行为。
 */
export function loadNativeBootstrapForReload({ href = "http://127.0.0.1:1234/?runtime=native&token=secret&foo=bar#section" } = {}) {
	const navigation = { replaced: [], reloads: 0, historyUrls: [] };
	const transports = [];
	class FakeTransport {
		constructor(_baseUrl, _token, options) {
			this.options = options;
			transports.push(this);
		}
		ready() {
			return Promise.resolve();
		}
		reconnect() {}
		invoke() {
			return Promise.resolve();
		}
		subscribe() {
			return () => undefined;
		}
		getLastEventSeq() {
			return 0;
		}
		getEventSourceGeneration() {
			return "";
		}
		handleHeartbeat() {}
		activateAfter() {}
	}
	const url = new URL(href);
	const window = {
		location: {
			href,
			search: url.search,
			origin: url.origin,
			replace: (next) => navigation.replaced.push(next),
			reload: () => {
				navigation.reloads += 1;
			},
		},
		history: { replaceState: (_state, _title, next) => navigation.historyUrls.push(next) },
		setTimeout: () => 1,
		clearTimeout: () => undefined,
		setInterval: () => 1,
		clearInterval: () => undefined,
		addEventListener: () => undefined,
		dispatchEvent: () => true,
	};
	const module = loadTsCommonJs("src/renderer/src/native/initializeNativeDesktop.ts", {
		stubs: {
			"@shared/desktop/createPiDesktopApi": { createPiDesktopApi: () => ({ fake: true }) },
			"./NativeDesktopSyncHost": { NativeDesktopSyncHost: class { update() {} } },
			"./NativeDesktopTransport": { NativeDesktopTransport: FakeTransport },
			"./nativeHeartbeat": { createNativeHeartbeatRequest: () => ({ run() {}, dispose() {} }) },
			"./rendererZoom": { applyRendererZoom: () => undefined },
		},
		globals: {
			window,
			fetch: async () => ({ ok: true, status: 200, json: async () => ({ eventSeq: 0, clipboard: {}, settings: {} }) }),
			CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
		},
	});
	return { module, navigation, transports };
}