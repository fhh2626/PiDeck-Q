import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

test("desktop API readProcessEvents invokes the process-events channel with the session id and returns its result", async () => {
	const { createPiDesktopApi } = loadTsCommonJs("src/shared/desktop/createPiDesktopApi.ts");
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const calls = [];
	const expected = [{ kind: "session" }];
	const api = createPiDesktopApi(
		{
			invoke: async (channel, ...args) => {
				calls.push([channel, ...args]);
				return expected;
			},
			subscribe: () => () => undefined,
		},
		{
			readClipboardText: () => "", readClipboardHtml: () => "", readClipboardImage: () => "",
			getPathForFile: () => "", getClipboardPaths: () => [],
		},
	);
	assert.equal(await api.sessions.readProcessEvents("rec1"), expected);
	assert.deepEqual(calls, [[ipcChannels.sessionsCatalogReadProcessEvents, "rec1"]]);
});

test("process-event channel name stays on the wire-format string", () => {
	// 通道名是跨进程线上契约（Qt 宿主/Sidecar/渲染层共用），改名即协议破坏，字面量断言合理。
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	assert.equal(ipcChannels.sessionsCatalogReadProcessEvents, "sessions:catalog-read-process-events");
});
