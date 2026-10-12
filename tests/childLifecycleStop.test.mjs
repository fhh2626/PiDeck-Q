/**
 * 子会话停止信号投影（projectChildLifecycle）单测。
 *
 * 覆盖“停了就必须回主 agent”这一条缺口：agent_end 之后如果既没有
 * agent_settled 也没有干净的助手 stop，观察者必须启动短等待并在超时后
 * 以「停止但没有结果」结束，而不是干等到整轮超时；同时压缩、重试、新一
 * 轮 agent_start 都表示子会话仍在继续，必须取消该等待。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_URL = pathToFileURL(path.join(
	HERE,
	"..",
	"resources",
	"extensions",
	"pideck-q-subagents",
	"src",
	"runs",
	"shared",
	"child-lifecycle.ts",
)).href;

const { projectChildLifecycle } = await import(MODULE_URL);

test("agent_end without retry arms the unsettled wait and clears the compaction retry flag", () => {
	const state = { compactionRetryActive: true };
	assert.equal(projectChildLifecycle({ type: "agent_end" }, false, state), "arm-unsettled-end");
	assert.equal(state.compactionRetryActive, false);
});

test("agent_end asking for a retry still cancels the drain", () => {
	const state = { compactionRetryActive: false };
	assert.equal(projectChildLifecycle({ type: "agent_end", willRetry: true }, false, state), "cancel-drain");
});

test("compaction start cancels the unsettled wait without touching the retry flag", () => {
	const state = { compactionRetryActive: true };
	assert.equal(projectChildLifecycle({ type: "compaction_start" }, false, state), "cancel-unsettled-end");
	assert.equal(state.compactionRetryActive, true);
});

test("agent_start and auto_retry_start cancel the unsettled wait", () => {
	const state = { compactionRetryActive: true };
	assert.equal(projectChildLifecycle({ type: "agent_start" }, false, state), "cancel-unsettled-end");
	assert.equal(state.compactionRetryActive, false);

	const retryState = { compactionRetryActive: true };
	assert.equal(projectChildLifecycle({ type: "auto_retry_start" }, false, retryState), "cancel-unsettled-end");
	assert.equal(retryState.compactionRetryActive, false);
});

test("compaction_end keeps its existing retry semantics", () => {
	const retryState = { compactionRetryActive: false };
	assert.equal(projectChildLifecycle({ type: "compaction_end", willRetry: true }, false, retryState), "cancel-drain");
	assert.equal(retryState.compactionRetryActive, true);

	const doneState = { compactionRetryActive: true };
	assert.equal(projectChildLifecycle({ type: "compaction_end" }, false, doneState), "none");
	assert.equal(doneState.compactionRetryActive, false);
});

test("agent_settled starts the drain unless a compaction retry is in flight", () => {
	const settledState = { compactionRetryActive: false };
	assert.equal(projectChildLifecycle({ type: "agent_settled" }, false, settledState), "start-drain");

	const retryingState = { compactionRetryActive: true };
	assert.equal(projectChildLifecycle({ type: "agent_settled" }, false, retryingState), "none");
});

test("a clean terminal assistant stop still starts the drain", () => {
	const state = { compactionRetryActive: false };
	assert.equal(projectChildLifecycle({ type: "message_end" }, true, state), "start-drain");
});

test("unrelated events leave the lifecycle alone", () => {
	const state = { compactionRetryActive: false };
	assert.equal(projectChildLifecycle({ type: "message_update" }, false, state), "none");
	assert.equal(projectChildLifecycle({ type: "tool_execution_end" }, false, state), "none");
});
