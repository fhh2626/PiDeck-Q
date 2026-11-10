import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	parseWorkflowChildSummary,
	workflowChildSummary,
} from "../resources/extensions/pideck-q-subagents/src/workflows/workflow-child-summary.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SubagentRunTracker } = loadTsCommonJs("src/main/pi/SubagentRunTracker.ts");

// 跨仓契约：workflowScript 的运行中子代理只出现在 workflowChildren（results[]
// 要等子代理收尾才填充），因此 PiDeck 的侧栏状态灯必须能从这一行拿到 sessionFile。
// 这里直接跑扩展的 summary builder + PiDeck tracker，防止任一侧把字段删掉。

const PARENT_TOOL_CALL_ID = "call-workflow";
const WORKFLOW_RUN_ID = "workflow-run";

function traceStarted(key) {
	return { operation: "run", key, state: "started" };
}

function runningRow(overrides = {}) {
	return {
		parentToolCallId: PARENT_TOOL_CALL_ID,
		workflowRunId: WORKFLOW_RUN_ID,
		workflowState: "running",
		inventoryComplete: false,
		trace: [traceStarted("factory-stream-review")],
		...overrides,
	};
}

test("workflow summary exposes a launch-resolved sessionFile before the first progress frame", () => {
	const summary = workflowChildSummary({
		...runningRow(),
		sessionFiles: new Map([["factory-stream-review", "C:/sessions/child.jsonl"]]),
	});

	assert.equal(summary.children.length, 1);
	assert.equal(summary.children[0].state, "running");
	assert.equal(summary.children[0].sessionFile, "C:/sessions/child.jsonl");

	// status.json 的读取路径也必须接受该字段，否则前台 handoff 后状态会被判坏。
	const parsed = parseWorkflowChildSummary(summary);
	assert.equal(parsed?.children[0].sessionFile, "C:/sessions/child.jsonl");
});

test("launch identity wins over a retained auto-resume trace id while running", () => {
	const summary = workflowChildSummary({
		...runningRow(),
		trace: [{ ...traceStarted("factory-stream-review"), runId: "retained-source-id" }],
		sessionFiles: new Map([["factory-stream-review", "C:/sessions/child.jsonl"]]),
		runIds: new Map([["factory-stream-review", "actual-new-execution"]]),
	});
	assert.equal(summary.children[0].runId, "actual-new-execution");
});

test("foreground workflow wires launch session files into the live summary", () => {
	// 行为测试覆盖 builder；这段契约测试保证 executor 真的把 launch.sessionFile
	// 传进 workflowChildren，而不是只让 builder 支持一个没人填的字段。
	const source = readFileSync(
		"resources/extensions/pideck-q-subagents/src/runs/foreground/subagent-executor.ts",
		"utf8",
	);
	assert.match(source, /const childSessionFiles = new Map<string, string>\(\);/);
	assert.match(source, /childSessionFiles\.set\(key, launch\.sessionFile\)/);
	assert.match(source, /workflowChildProgress\(progress, childSessionFiles\.get\(key\)\)/);
	assert.match(source, /sessionFiles: childSessionFiles/);
});

test("a finished workflow child keeps sessionFile so a progress frame can clear its light", () => {
	const summary = workflowChildSummary({
		...runningRow(),
		trace: [
			{ operation: "run", key: "factory-stream-review", state: "completed" },
			{ operation: "run", key: "config-cache-review", state: "started" },
		],
		sessionFiles: new Map([
			["factory-stream-review", "C:/sessions/done.jsonl"],
			["config-cache-review", "C:/sessions/live.jsonl"],
		]),
	});
	const byId = Object.fromEntries(summary.children.map((child) => [child.childId, child]));
	assert.equal(byId["factory-stream-review"].state, "completed");
	assert.equal(byId["factory-stream-review"].sessionFile, "C:/sessions/done.jsonl");
	assert.equal(byId["config-cache-review"].state, "running");
	assert.equal(byId["config-cache-review"].sessionFile, "C:/sessions/live.jsonl");
});

test("an authoritative result path is not overwritten by the launch guess", () => {
	// 恢复/迁移等情况下 launch 解析的路径可能和真实结果的会话文件不同；
	// 有真实结果时以结果为准，否则侧栏会点错行。
	const summary = workflowChildSummary({
		...runningRow(),
		workflowState: "completed",
		inventoryComplete: true,
		trace: [{ operation: "run", key: "factory-stream-review", state: "completed" }],
		children: [{
			key: "factory-stream-review",
			ok: true,
			agent: "readonly",
			output: "done",
			artifactPaths: [],
			results: [{ sessionFile: "C:/sessions/authoritative.jsonl", exitCode: 0 }],
		}],
		sessionFiles: new Map([["factory-stream-review", "C:/sessions/launch-guess.jsonl"]]),
	});
	assert.equal(summary.children[0].sessionFile, "C:/sessions/authoritative.jsonl");
});

test("terminal rows keep the session link in the final summary", () => {
	// 最终 summary 会写进 status.json / 回执，供 handoff 后回看；失败/停止行
	// 若没有 result 行，路径只能来自 launch 记录，否则会话链接就丢了。
	const summary = workflowChildSummary({
		...runningRow(),
		workflowState: "failed",
		inventoryComplete: true,
		trace: [{ operation: "run", key: "factory-stream-review", state: "failed" }],
		sessionFiles: new Map([["factory-stream-review", "C:/sessions/broken.jsonl"]]),
	});
	assert.equal(summary.children[0].state, "failed");
	assert.equal(summary.children[0].sessionFile, "C:/sessions/broken.jsonl");
	assert.equal(parseWorkflowChildSummary(summary)?.children[0].sessionFile, "C:/sessions/broken.jsonl");
});

test("a stopped child settles its light instead of leaving it running", () => {
	const tracker = new SubagentRunTracker();
	const event = (state) => ({
		toolName: "subagent",
		partialResult: {
			details: {
				mode: "workflow",
				results: [],
				workflowChildren: workflowChildSummary({
					...runningRow(),
					trace: [{ operation: "run", key: "factory-stream-review", state }],
					sessionFiles: new Map([["factory-stream-review", "C:/sessions/stopped.jsonl"]]),
				}),
			},
		},
	});
	assert.equal(tracker.observe("agent-1", event("started"), 1_000), true);
	assert.equal(tracker.snapshot("agent-1", 1_000).length, 1);
	// stopped/paused 在侧栏没有单独状态，按「不再运行」收灯，不能留黄灯。
	assert.equal(tracker.observe("agent-1", event("stopped"), 2_000), true);
	assert.equal(tracker.snapshot("agent-1", 2_000).length, 0);
});

test("workflow summary carries sessionFile from progress without a separate map", () => {
	const summary = workflowChildSummary({
		...runningRow(),
		progress: new Map([["factory-stream-review", {
			agent: "readonly",
			sessionFile: "C:/sessions/progress.jsonl",
			currentTool: "read",
		}]]),
	});

	assert.equal(summary.children[0].sessionFile, "C:/sessions/progress.jsonl");
	assert.equal(summary.children[0].activity?.currentTool, "read");
});

test("the sidebar tracker lights the live workflow child from the real summary shape", () => {
	const summary = workflowChildSummary({
		...runningRow(),
		sessionFiles: new Map([["factory-stream-review", "C:/sessions/child.jsonl"]]),
	});
	const tracker = new SubagentRunTracker();
	const event = {
		type: "tool_execution_update",
		toolName: "subagent",
		toolCallId: PARENT_TOOL_CALL_ID,
		partialResult: {
			content: [],
			details: { mode: "workflow", results: [], workflowChildren: summary },
		},
	};

	assert.equal(tracker.observe("agent-1", event, 1_000), true);
	assert.deepEqual(
		Array.from(tracker.snapshot("agent-1", 1_000), (run) => `${run.sessionFile}|${run.status}`),
		["C:/sessions/child.jsonl|running"],
	);

	const completedSummary = workflowChildSummary({
		...runningRow(),
		trace: [{ operation: "run", key: "factory-stream-review", state: "completed" }],
		children: [{
			key: "factory-stream-review",
			ok: true,
			agent: "readonly",
			output: "done",
			artifactPaths: [],
			results: [{ sessionFile: "C:/sessions/child.jsonl", exitCode: 0 }],
		}],
		inventoryComplete: true,
	});
	const endEvent = {
		type: "tool_execution_end",
		toolName: "subagent",
		toolCallId: PARENT_TOOL_CALL_ID,
		result: {
			content: [],
			details: { mode: "workflow", results: [], workflowChildren: completedSummary },
		},
	};
	assert.equal(tracker.observe("agent-1", endEvent, 2_000), true);
	assert.equal(tracker.snapshot("agent-1", 2_000).length, 0);
});
