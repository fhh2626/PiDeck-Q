import assert from "node:assert/strict";
import test from "node:test";
import {
	effectiveToolTimeoutMs,
	resolveToolTimeoutMs,
} from "../resources/extensions/pideck-q-subagents/src/runs/shared/tool-timeout.ts";

test("tools have no implicit deadline when every timeout setting is omitted", () => {
	const resolved = resolveToolTimeoutMs({});
	assert.deepEqual(resolved, {});
	for (const toolName of ["read", "grep", "find", "ls", "edit", "write", "structured_output", "bash", "powershell", "custom_tool"]) {
		assert.equal(effectiveToolTimeoutMs(toolName, resolved.toolTimeoutMs), undefined, toolName);
	}
});

test("explicit tool deadlines retain call, agent, config, and environment precedence", () => {
	const candidates = { callValue: 1200, agentValue: 2400, configValue: 3600, envValue: "4800" };
	for (const key of ["callValue", "agentValue", "configValue", "envValue"]) {
		const expected = Number(candidates[key]);
		const resolved = resolveToolTimeoutMs(candidates);
		assert.deepEqual(resolved, { toolTimeoutMs: expected });
		assert.equal(effectiveToolTimeoutMs("read", resolved.toolTimeoutMs), expected);
		delete candidates[key];
	}
	assert.deepEqual(resolveToolTimeoutMs(candidates), {});
});

test("supervisor and wait tools remain exempt from explicitly configured deadlines", () => {
	for (const toolName of ["contact_supervisor", "intercom", "bg_wait"]) {
		assert.equal(effectiveToolTimeoutMs(toolName, 1000), undefined, toolName);
	}
});

test("each explicit tool timeout source rejects values that would overflow Node timers", () => {
	for (const key of ["callValue", "agentValue", "configValue", "envValue"]) {
		const value = key === "envValue" ? "2147483648" : 2_147_483_648;
		assert.match(resolveToolTimeoutMs({ [key]: value }).error ?? "", /2147483647/);
	}
});
