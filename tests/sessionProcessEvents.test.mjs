import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

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

test("process-event IPC is wired on channel, handler, and preload", () => {
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	const handler = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
	const preload = readFileSync("src/shared/desktop/createPiDesktopApi.ts", "utf8");
	assert.match(ipc, /sessionsCatalogReadProcessEvents: "sessions:catalog-read-process-events"/);
	assert.match(handler, /sessionsCatalogReadProcessEvents/);
	assert.match(handler, /parseSessionProcessEvents/);
	assert.match(preload, /readProcessEvents:/);
	assert.match(preload, /sessionsCatalogReadProcessEvents/);
});
