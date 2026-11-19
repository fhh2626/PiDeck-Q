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

const {
	DELEGATION_HINT,
	SUBAGENT_CALL_ANNOUNCEMENT_HINT,
	appendDelegationHint,
	appendSubagentCallAnnouncementHint,
	isSubagentChildProcess,
	shouldInjectDelegationHint,
	shouldInjectSubagentCallAnnouncementHint,
} =
	await load("extension/delegation-hint.ts");
const agentsModule = await load("agents/agents.ts");
const { DEFAULT_CONFIG, DEFAULT_PROMPTS } = await import("../resources/extensions/pideck-q-change-pi-prompt/defaults.ts");
const { transformSystemPrompt } = await import("../resources/extensions/pideck-q-change-pi-prompt/transform.ts");

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

test("subagent announcements use one English rule independently of the delegation preference", () => {
	const base = "You are a helpful agent.";
	const once = appendSubagentCallAnnouncementHint(base, true);
	assert.equal(once, `${base}\n\n${SUBAGENT_CALL_ANNOUNCEMENT_HINT}`);
	assert.doesNotMatch(SUBAGENT_CALL_ANNOUNCEMENT_HINT, /[^\x00-\x7f]/);
	assert.equal(appendSubagentCallAnnouncementHint(once, true), once);
	assert.equal(appendSubagentCallAnnouncementHint(base, false), base);
	assert.equal(appendSubagentCallAnnouncementHint("   ", true), SUBAGENT_CALL_ANNOUNCEMENT_HINT);
	assert.equal(appendDelegationHint(once, false), once);
	assert.equal(appendSubagentCallAnnouncementHint(appendDelegationHint(base, true), true).split(SUBAGENT_CALL_ANNOUNCEMENT_HINT).length - 1, 1);
});

test("both extension orders preserve exactly one announcement and unrelated prompt text", () => {
	const suffix = "\n\n<project_context>Keep my project instructions.\r\n</project_context>";
	const base = "You are an expert coding assistant operating inside pi, a coding agent harness.\n\nAvailable tools:\n- subagent: Delegate\n\nGuidelines:\n- Be concise in your responses\n\nPi documentation (read only when the user asks about pi itself):\n- Main documentation: /pi/README.md\n- Additional docs: /pi/docs\n- Examples: /pi/examples" + suffix;
	const transform = systemPrompt => transformSystemPrompt({
		systemPrompt,
		tools: [{ name: "subagent", sourceInfo: { source: "npm:pi-subagents" } }],
		activeTools: ["subagent"],
		config: DEFAULT_CONFIG,
		prompts: DEFAULT_PROMPTS,
		hostOs: "Linux",
		today: "2026-11-18",
	}).systemPrompt;
	for (const result of [
		transform(appendSubagentCallAnnouncementHint(base, true)),
		appendSubagentCallAnnouncementHint(transform(base), true),
	]) {
		assert.equal(result.split(SUBAGENT_CALL_ANNOUNCEMENT_HINT).length - 1, 1);
		assert.ok(result.includes(suffix));
		assert.equal(appendSubagentCallAnnouncementHint(result, true), result);
	}
});

test("subagent announcements apply only to a main session with the tool available", () => {
	assert.equal(shouldInjectSubagentCallAnnouncementHint({ subagentToolAvailable: true, env: {} }), true);
	assert.equal(shouldInjectSubagentCallAnnouncementHint({ subagentToolAvailable: false, env: {} }), false);
	assert.equal(shouldInjectSubagentCallAnnouncementHint({ subagentToolAvailable: true, env: { PI_SUBAGENT_CHILD: "1" } }), false);
	for (const systemPrompt of [
		'<active_agent name="readonly"/>\nYou are a child.',
		"<active_agent name='writable'>\nYou are a child.",
		"<!-- change-pi-prompt:child-tools:v1 -->\nYou are a child.",
		"<!-- pideck-subagent:child-tools:v1 -->\nYou are a child.",
	]) {
		assert.equal(shouldInjectSubagentCallAnnouncementHint({ subagentToolAvailable: true, systemPrompt, env: {} }), false);
	}
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
	assert.equal(shouldInjectDelegationHint({
		cwd: projectDir,
		subagentToolAvailable: true,
		systemPrompt: '<active_agent name="readonly"/>',
		env: {},
	}), false);

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
