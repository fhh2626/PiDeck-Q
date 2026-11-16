import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("AgentRuntimeState carries perf fields", () => {
	const source = readFileSync("src/shared/types/agent.ts", "utf8");
	for (const field of ["ttftMs?: number", "totalMs?: number", "tps?: number", "perfAt?: number"]) {
		assert.match(source, new RegExp(field.replace("?", "\\?")), `missing ${field}`);
	}
});

test("ctx.detail shows TTFT / total time / speed with i18n labels", () => {
	const surface = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
	assert.match(surface, /state\.ttftMs != null/);
	assert.match(surface, /state\.totalMs != null/);
	assert.match(surface, /state\.tps != null/);
	assert.match(surface, /const replyPerfRows/);
	assert.match(surface, /t\("ctx\.detail\.ttft"\), value: formatDuration\(state\.ttftMs\)/);
	assert.match(surface, /t\("ctx\.detail\.total"\), value: formatDuration\(state\.totalMs\)/);
	assert.match(surface, /t\("ctx\.detail\.tps"\), value: `\$\{state\.tps\.toFixed\(0\)\} tok\/s`/);
	assert.match(surface, /t\("ctx\.detail\.lastReply"\)/);
	assert.match(surface, /border-t border-border\/70 pt-2/);
});

test("perf i18n keys exist in zh-CN and en-US", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	for (const key of ["ctx.detail.ttft", "ctx.detail.total", "ctx.detail.tps", "ctx.detail.lastReply"]) {
		assert.match(zh, new RegExp(`"${key}":`), `zh-CN missing ${key}`);
		assert.match(en, new RegExp(`"${key}":`), `en-US missing ${key}`);
	}
});
