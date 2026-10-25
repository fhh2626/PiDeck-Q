import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function loadModule() {
	const source = readFileSync("src/main/sessions/sessionProcessEvents.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = { exports: {}, module: { exports: {} } };
	sandbox.module.exports = sandbox.exports;
	vm.runInNewContext(outputText, sandbox, { filename: "sessionProcessEvents.ts" });
	return sandbox.exports;
}

test("parseSessionProcessEvents keeps session/model/thinking/custom and skips messages", () => {
	const { parseSessionProcessEvents } = loadModule();
	const raw = [
		JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" }),
		JSON.stringify({ type: "model_change", id: "m1", timestamp: "2026-01-01T00:00:01.000Z", provider: "openai", modelId: "gpt-4.1" }),
		JSON.stringify({ type: "thinking_level_change", id: "t1", timestamp: "2026-01-01T00:00:02.000Z", thinkingLevel: "low" }),
		JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: "hi" } }),
		JSON.stringify({ type: "custom", id: "c1", timestamp: "2026-01-01T00:00:03.000Z", customType: "pi-deck-todo", content: "- [ ] a" }),
		JSON.stringify({ type: "compaction", id: "k1", timestamp: "2026-01-01T00:00:04.000Z", summary: "compacted", tokensBefore: 80000 }),
	].join("\n");
	const events = parseSessionProcessEvents(raw);
	assert.equal(events.map((event) => event.kind).join(","), "session,modelChange,thinkingChange,custom,compaction");
	assert.equal(events[0].cwd, "/repo");
	assert.equal(events[1].modelId, "gpt-4.1");
	assert.equal(events[2].thinkingLevel, "low");
	assert.equal(events[3].customType, "pi-deck-todo");
	assert.equal(events[4].tokensBefore, 80000);
});

/** 注册真实 sessionIpc，只注入 process-events handler 用到的依赖。 */
function registerProcessEventsHandler({ entries, rawTextByPath }) {
	const { registerSessionIpc } = loadTsCommonJs("src/main/ipc/sessionIpc.ts");
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const handlers = new Map();
	const reads = [];
	registerSessionIpc(
		{ handle: (channel, handler) => handlers.set(channel, handler) },
		{
			sessionScanner: {
				readSessionRawText: async (filePath) => {
					reads.push(filePath);
					return rawTextByPath[filePath];
				},
			},
			sessionCatalog: { get: (id) => entries[id] },
		},
	);
	return {
		reads,
		invoke: (sessionId) => handlers.get(ipcChannels.sessionsCatalogReadProcessEvents)(sessionId),
	};
}

const SESSION_LINE = JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" });

test("process-event IPC handler reads the catalog entry's JSONL and returns parsed events", async () => {
	const harness = registerProcessEventsHandler({
		entries: { rec1: { filePath: "/sessions/a.jsonl" } },
		rawTextByPath: { "/sessions/a.jsonl": SESSION_LINE },
	});
	const events = await harness.invoke("rec1");
	assert.deepEqual(Array.from(harness.reads), ["/sessions/a.jsonl"]);
	assert.equal(events.length, 1);
	assert.equal(events[0].kind, "session");
	assert.equal(events[0].cwd, "/repo");
});

test("process-event IPC handler returns [] without touching disk for blank, non-string or unknown sessions", async () => {
	const harness = registerProcessEventsHandler({
		// 空白/undefined 键故意映射到真实文件：若入参校验缺失，会读盘并返回事件，测试即失败
		entries: { noFile: {}, "  ": { filePath: "/x.jsonl" }, undefined: { filePath: "/x.jsonl" } },
		rawTextByPath: { "/x.jsonl": SESSION_LINE },
	});
	// 渲染层入参不可信：非法 id / 无文件的目录项都应得到空数组而不是抛错或读盘
	assert.deepEqual(Array.from(await harness.invoke("  ")), []);
	assert.deepEqual(Array.from(await harness.invoke(undefined)), []);
	assert.deepEqual(Array.from(await harness.invoke("missing")), []);
	assert.deepEqual(Array.from(await harness.invoke("noFile")), []);
	assert.deepEqual(harness.reads, []);
});

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