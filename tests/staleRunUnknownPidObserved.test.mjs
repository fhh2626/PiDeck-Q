/**
 * 异步 runner 的 pid 检查无法确认退出时的兜底测试。
 *
 * 回归目标：runner 已记录进程 close（process-terminal.json 为 observed），
 * 但 pid 检查只得到 unknown（例如 EPERM）时，必须立刻按失败修复，让主 agent
 * 拿到结果，而不是干等到 24 小时的 stale 阈值。同时保持原有语义：
 * - 没有进程退出证明时，unknown 不做修复；
 * - pid 明确不存在（ESRCH）时仍立刻修复；
 * - pid 仍 alive 时，即使有 observed 证明也不误杀。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installSubagentGraphLoader } from "./helpers/subagentGraphLoader.mjs";

installSubagentGraphLoader();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_URL = pathToFileURL(path.join(
	HERE,
	"..",
	"resources",
	"extensions",
	"pideck-q-subagents",
	"src",
	"runs",
	"background",
	"stale-run-reconciler.ts",
)).href;

const { reconcileAsyncRun } = await import(MODULE_URL);

const RUN_ID = "run-1";
const SESSION_ID = "parent-session";

function makeAsyncDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "stale-run-"));
}

function writeStatus(asyncDir, now) {
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
		runId: RUN_ID,
		state: "running",
		pid: 4242,
		sessionId: SESSION_ID,
		mode: "single",
		startedAt: now,
		lastUpdate: now,
		steps: [{ agent: "worker", status: "running", startedAt: now }],
	}), "utf-8");
}

function writeObservedProcessTerminal(asyncDir) {
	fs.writeFileSync(path.join(asyncDir, "process-terminal.json"), JSON.stringify({
		version: 1,
		state: "observed",
		runId: RUN_ID,
		runnerProcessInstanceId: "runner-1",
		observedAt: 1,
		instances: [
			{
				kind: "runner",
				processInstanceId: "runner-1",
				closeObservedAt: 1,
				exitCode: 1,
				signal: null,
			},
		],
	}), "utf-8");
}

function killWithCode(code) {
	return () => {
		const error = new Error(`kill failed: ${code}`);
		error.code = code;
		throw error;
	};
}

test("pid unknown with an observed process-terminal proof repairs the run as failed", () => {
	const asyncDir = makeAsyncDir();
	try {
		const now = Date.now();
		writeStatus(asyncDir, now);
		writeObservedProcessTerminal(asyncDir);

		const result = reconcileAsyncRun(asyncDir, {
			resultsDir: path.join(asyncDir, "results"),
			kill: killWithCode("EPERM"),
			now: () => now,
		});

		assert.equal(result.repaired, true);
		assert.equal(result.status?.state, "failed");
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("pid unknown without a process-terminal proof keeps the run running", () => {
	const asyncDir = makeAsyncDir();
	try {
		const now = Date.now();
		writeStatus(asyncDir, now);

		const result = reconcileAsyncRun(asyncDir, {
			resultsDir: path.join(asyncDir, "results"),
			kill: killWithCode("EPERM"),
			now: () => now,
		});

		assert.equal(result.repaired, false);
		assert.equal(result.status?.state, "running");
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("a missing pid still repairs the run immediately", () => {
	const asyncDir = makeAsyncDir();
	try {
		const now = Date.now();
		writeStatus(asyncDir, now);

		const result = reconcileAsyncRun(asyncDir, {
			resultsDir: path.join(asyncDir, "results"),
			kill: killWithCode("ESRCH"),
			now: () => now,
		});

		assert.equal(result.repaired, true);
		assert.equal(result.status?.state, "failed");
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("a live pid is never failed by an observed proof from an earlier runner", () => {
	const asyncDir = makeAsyncDir();
	try {
		const now = Date.now();
		writeStatus(asyncDir, now);
		writeObservedProcessTerminal(asyncDir);

		const result = reconcileAsyncRun(asyncDir, {
			resultsDir: path.join(asyncDir, "results"),
			kill: () => true,
			now: () => now,
		});

		assert.equal(result.repaired, false);
		assert.equal(result.status?.state, "running");
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});
