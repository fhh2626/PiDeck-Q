import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("native/src/NodeProcessController.cpp", "utf8");
const header = readFileSync("native/src/NodeProcessController.h", "utf8");

test("native sidecar owns a Windows Job Object with kill-on-close semantics", () => {
	assert.match(source, /CreateJobObjectW/);
	assert.match(source, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
	assert.match(source, /SetInformationJobObject/);
	assert.match(source, /AssignProcessToJobObject/);
	assert.match(source, /TerminateJobObject/);
	assert.match(header, /void \*m_jobHandle = nullptr/);
});

test("native sidecar fallback kills only the tracked PID tree", () => {
	assert.match(source, /taskkill\.exe/);
	assert.match(source, /["']\/PID["']/);
	assert.match(source, /["']\/T["']/);
	assert.match(source, /["']\/F["']/);
	assert.doesNotMatch(source, /["']\/IM["']\s*,\s*["']node\.exe["']/i);
});

test("native sidecar keeps graceful cleanup bounded before forced termination", () => {
	assert.match(source, /constexpr int gracefulTimeoutMs = 250/);
	assert.match(source, /waitForFinished\(gracefulTimeoutMs\)/);
	assert.match(source, /waitForFinished\(100\)/);
});
