import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * hook 与源码契约：Shiki 不得留在主线程、不得静默回退、不得有 startsWith 复用分支。
 *
 * 行为面（调度器）已由 agentCodeHighlightClient.test.mjs 覆盖；
 * 这里锁定「主线程不再直接算高亮」这一结构性约束，以及 hook 的依赖语义。
 */

const codePath = "src/renderer/src/components/agents/agent-code.tsx";
const clientPath = "src/renderer/src/components/agents/agentCodeHighlightClient.ts";
const workerPath = "src/renderer/src/components/agents/agentCodeHighlight.worker.ts";
const factoryPath = "src/renderer/src/components/agents/agentCodeHighlightWorkerFactory.ts";
const codeSource = readFileSync(codePath, "utf8");
const clientSource = readFileSync(clientPath, "utf8");
const workerSource = readFileSync(workerPath, "utf8");
const factorySource = readFileSync(factoryPath, "utf8");

test("agent-code 不再直接调用 shiki", () => {
	assert.doesNotMatch(codeSource, /from "shiki"/, "agent-code must not import shiki");
	assert.doesNotMatch(codeSource, /createHighlighter\(/, "agent-code must not create a highlighter");
	assert.doesNotMatch(
		codeSource,
		/codeToTokensWithThemes\(/,
		"main thread must not compute tokens",
	);
});

test("agent-code 没有 startsWith 复用分支", () => {
	assert.doesNotMatch(
		codeSource,
		/code\.startsWith\(result\.code\)/,
		"the prefix-reuse branch must be removed",
	);
});

test("agent-code 对 Worker 结果/失败都不回退到主线程", () => {
	assert.doesNotMatch(
		codeSource,
		/getAgentCodeHighlightClient\(\)\.request\([^)]*\)\.then\([\s\S]{0,400}catch\([\s\S]{0,200}codeToTokens/,
		"no main-thread fallback in the catch path",
	);
	// catch 分支必须是空处理（保持 null → 纯文本呈现）。
	assert.match(
		codeSource,
		/\.catch\(\(\) => \{[\s\S]{0,160}?\}\)/,
		"the failure path must stay inert",
	);
});

test("Worker 入口是持有 import.meta.url 的唯一模块", () => {
	assert.match(
		factorySource,
		/new Worker\(\s*new URL\("\.\/agentCodeHighlight\.worker\.ts", import\.meta\.url\)/,
		"worker entry must be resolved via new URL(..., import.meta.url)",
	);
	assert.match(factorySource, /\{ type: "module" \}/, "the worker must be created as a module");
	assert.doesNotMatch(
		codeSource,
		/import\.meta\.url/,
		"agent-code must not hold import.meta (it must stay unit-testable)",
	);
	assert.doesNotMatch(
		clientSource,
		/import\.meta\.url/,
		"the client must not hold import.meta",
	);
});

test("Worker 使用与主线程相同的双主题与语言集合", () => {
	assert.match(workerSource, /github-light-high-contrast/);
	assert.match(workerSource, /github-dark-high-contrast/);
	for (const lang of ["bash", "diff", "json", "tsx", "typescript"]) {
		assert.ok(workerSource.includes(`"${lang}"`), `worker must register ${lang}`);
	}
});

test("Worker 计算是同步 shiki 调用，失败必须回传", () => {
	assert.match(workerSource, /codeToTokensWithThemes\(/, "worker must run shiki's sync API");
	assert.match(
		workerSource,
		/type: "highlight-error"/,
		"worker must report failures back to the main thread",
	);
});

test("client 暴露超时与空闲回收常量", () => {
	assert.match(clientSource, /HIGHLIGHT_TASK_TIMEOUT_MS = 30_000/);
	assert.match(clientSource, /HIGHLIGHT_IDLE_TEARDOWN_MS = 30_000/);
});

test("hook 取消订阅并清理（同一 effect 有 cancel）", () => {
	assert.match(
		codeSource,
		/handle\.promise[\s\S]{0,400}return \(\) => \{[\s\S]{0,120}handle\.cancel\(\)/,
		"the hook effect must cancel its own request on cleanup",
	);
});

test("hook 命中缓存时不发起 Worker 请求", () => {
	assert.match(
		codeSource,
		/const current = getCachedTokens\(key\);[\s\S]{0,200}setResult\(\{ key, code, language, lines: current \}\);[\s\S]{0,40}return;/,
		"a cache hit must short-circuit before requesting the worker",
	);
});
