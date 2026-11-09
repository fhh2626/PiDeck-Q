import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import "./helpers/piFixtureResolver.mjs";

const root = process.cwd();
const load = (relative) =>
	import(pathToFileURL(join(root, "resources/extensions/pideck-q-subagents/src", relative)).href);

const { DELEGATION_HINT, appendDelegationHint, isSubagentChildProcess, shouldInjectDelegationHint } =
	await load("extension/delegation-hint.ts");
const agentsModule = await load("agents/agents.ts");

/**
 * 「优先委派」提示词注入：
 * - 只在父会话 + subagent 工具可用 + 开关开启时追加；
 * - 幂等，不重复追加；
 * - 项目 settings 覆盖用户 settings。
 */

test("appendDelegationHint appends one paragraph and stays idempotent", () => {
	const base = "You are a helpful agent.";
	const once = appendDelegationHint(base, true);
	assert.equal(once, `${base}\n\n${DELEGATION_HINT}`);
	assert.equal(appendDelegationHint(once, true), once, "must not append twice");
	// 关闭时原样返回
	assert.equal(appendDelegationHint(base, false), base);
	// 空 systemPrompt 只留提示语，不留前导空行
	assert.equal(appendDelegationHint("   ", true), DELEGATION_HINT);
});

test("isSubagentChildProcess reads the child env flag", () => {
	assert.equal(isSubagentChildProcess({}), false);
	assert.equal(isSubagentChildProcess({ PI_SUBAGENT_CHILD: "1" }), true);
	assert.equal(isSubagentChildProcess({ PI_SUBAGENT_CHILD: "0" }), false);
	assert.equal(isSubagentChildProcess({ PI_SUBAGENT_CHILD: "false" }), false);
	assert.equal(isSubagentChildProcess({ PI_SUBAGENT_CHILD: "" }), false);
});

test("shouldInjectDelegationHint gates on tool availability, child process, and the setting", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-delegation-hint-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		agentsModule.clearAgentDiscoveryCache?.();
		rmSync(dir, { recursive: true, force: true });
	});
	const agentDir = join(dir, "agent");
	const projectDir = join(dir, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const writeSettings = (file, subagents) => {
		writeFileSync(file, JSON.stringify({ subagents }), "utf8");
	};
	const userSettings = join(agentDir, "settings.json");
	const projectSettings = join(projectDir, ".pi", "settings.json");
	mkdirSync(join(projectDir, ".pi"), { recursive: true });

	// 未配置：不注入
	assert.equal(shouldInjectDelegationHint({ cwd: projectDir, subagentToolAvailable: true }), false);
	// 工具不可用：即使开关开着也不注入（否则会引导模型调用不存在的工具）
	writeSettings(userSettings, { preferDelegation: true });
	assert.equal(shouldInjectDelegationHint({ cwd: projectDir, subagentToolAvailable: false }), false);
	// 子代理进程：不注入
	assert.equal(
		shouldInjectDelegationHint({ cwd: projectDir, subagentToolAvailable: true, env: { PI_SUBAGENT_CHILD: "1" } }),
		false,
	);
	// 父会话 + 开关开启：注入
	assert.equal(shouldInjectDelegationHint({ cwd: projectDir, subagentToolAvailable: true, env: {} }), true);

	// 项目配置覆盖全局：项目显式关闭后不注入
	writeSettings(projectSettings, { preferDelegation: false });
	assert.equal(shouldInjectDelegationHint({ cwd: projectDir, subagentToolAvailable: true, env: {} }), false);
	// 项目未声明时回落到全局
	writeSettings(projectSettings, {});
	assert.equal(shouldInjectDelegationHint({ cwd: projectDir, subagentToolAvailable: true, env: {} }), true);
});

test("resolveSubagentPreferDelegation tolerates a malformed settings file", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-delegation-hint-bad-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		agentsModule.clearAgentDiscoveryCache?.();
		rmSync(dir, { recursive: true, force: true });
	});
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(agentDir, "settings.json"), "{ not json", "utf8");

	// 配置损坏不能被当成「开启」，也不能让调用方抛错
	assert.equal(shouldInjectDelegationHint({ cwd: dir, subagentToolAvailable: true, env: {} }), false);
});
