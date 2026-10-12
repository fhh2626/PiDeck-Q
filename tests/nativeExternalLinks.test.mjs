import assert from "node:assert/strict";
import test from "node:test";
import { openExternalLink } from "../src/main/browser/externalLinks.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

test("native shell adapter still uses the external-links allowlist", async () => {
	const opened = [];
	await openExternalLink("https://example.com", { openInSystem: async (url) => opened.push(url) });
	await openExternalLink("mailto:user@example.com", { openInSystem: async (url) => opened.push(url) });
	await openExternalLink("file:///C:/secret.txt", { openInSystem: async (url) => opened.push(url) });
	assert.deepEqual(opened, ["https://example.com", "mailto:user@example.com"]);
});

// 只 stub shared/ipc，不 stub externalLinks，让真实的协议网关参与断言。
const { NativeBackendHost } = loadTsCommonJs("src/native-node/host/NativeBackendHost.ts", {
	stubs: {
		"../../shared/ipc": { ipcChannels: {} },
	},
});

function createBackendHostFixture() {
	const requests = [];
	const host = {
		on: () => () => undefined,
		request: async (method, params) => {
			requests.push({ method, params });
			return undefined;
		},
	};
	const rendererServer = { broadcast: () => undefined };
	const backendHost = new NativeBackendHost(host, rendererServer, () => ({
		showWindow: "Show",
		restart: "Restart",
		quit: "Quit",
	}));
	return { backendHost, requests };
}

test("detached NativeBackendHost.openExternalUrl still opens an allowlisted URL", async () => {
	const { backendHost, requests } = createBackendHostFixture();

	// IPC 注册时会把这个方法拆出来传递（registerBackendRpc 的 openExternalUrl: host.openExternalUrl），
	// 所以必须按“拆开后单独调用”的方式断言，不能写成 backendHost.openExternalUrl(...)。
	const detached = backendHost.openExternalUrl;
	await detached("http://127.0.0.1:8765/?pideck_token=test-token", true);

	// VM realm 里的对象不能直接 deepEqual（原型不同），取字段比较。
	assert.deepEqual(
		Array.from(requests, (entry) => ({ method: entry.method, url: entry.params.url })),
		[{ method: "shell.openExternal", url: "http://127.0.0.1:8765/?pideck_token=test-token" }],
	);
});

test("detached NativeBackendHost.openExternalUrl keeps rejecting non-allowlisted protocols", async () => {
	const { backendHost, requests } = createBackendHostFixture();

	const detached = backendHost.openExternalUrl;
	await detached("file:///C:/secret.txt", true);

	// 非白名单协议不调系统打开，也不得抛错（this 丢失时会在读 this.logger 时炸掉）。
	assert.equal(requests.length, 0);
});
