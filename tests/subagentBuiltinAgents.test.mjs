import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import "./helpers/piFixtureResolver.mjs";

const root = process.cwd();
const load = (relative) => import(pathToFileURL(join(root, "resources/extensions/pideck-q-subagents/src", relative)).href);
const agentsModule = await load("agents/agents.ts");
const defaultAgent = await load("agents/default-agent.ts");
const inheritance = await load("agents/parent-tool-inheritance.ts");
const childLaunch = await load("runs/shared/child-launch.ts");
const mcpAllowlist = await load("runs/shared/mcp-direct-tool-allowlist.ts");

/** Discovers builtins in an isolated agent dir so user agents/overrides cannot leak into the result. */
function discoverBuiltins(t) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-builtin-agents-"));
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
	agentsModule.clearAgentDiscoveryCache?.();
	return agentsModule.discoverAgents(projectDir, "user").agents.filter((agent) => agent.source === "builtin");
}

test("only readonly and writable are bundled, and both copy the parent's tools", (t) => {
	const builtins = discoverBuiltins(t);
	assert.deepEqual(builtins.map((agent) => agent.name).sort(), ["readonly", "writable"]);
	for (const agent of builtins) {
		assert.equal(agent.inheritParentTools, true, `${agent.name} must declare tools: parent`);
		assert.equal(agent.defaultContext, "fork", `${agent.name} must default to forked context`);
		assert.equal(agent.systemPromptMode, "append");
		// Model and thinking come from the parent: nothing pinned in the definition.
		assert.equal(agent.model, undefined);
		assert.equal(agent.thinking, undefined);
	}
});

test("readonly blacklists edit and write and forbids file-modifying shell use; writable adds no prompt", (t) => {
	const builtins = discoverBuiltins(t);
	const readonly = builtins.find((agent) => agent.name === "readonly");
	const writable = builtins.find((agent) => agent.name === "writable");
	assert.deepEqual([...readonly.excludeTools].sort(), ["edit", "write"]);
	assert.match(readonly.systemPrompt, /git add\/commit\/checkout/);
	assert.match(readonly.systemPrompt, /package installs/);
	assert.match(readonly.systemPrompt, /output redirection/);
	assert.equal(writable.excludeTools, undefined);
	assert.equal(writable.systemPrompt.trim(), "");
});

test("the readonly blacklist survives parent-tool resolution and removes edit/write from the copy", (t) => {
	const builtins = discoverBuiltins(t);
	const parentTools = ["read", "edit", "write", "bash", "grep"];
	const context = {
		allTools: parentTools.map((name) => ({ name, sourceInfo: { source: "builtin" } })),
		activeToolNames: parentTools,
	};
	const [readonly, writable] = inheritance.applyParentToolInheritance(
		["readonly", "writable"].map((name) => builtins.find((agent) => agent.name === name)),
		() => context,
	);
	assert.equal(readonly.tools.includes("edit"), false);
	assert.equal(readonly.tools.includes("write"), false);
	assert.equal(readonly.tools.includes("bash"), true, "the shell stays available for reading");
	assert.equal(writable.tools.includes("edit"), true);
	assert.equal(writable.tools.includes("write"), true);
});

test("parent MCP direct tools are carried as mcp selectors and honor the blacklist", () => {
	const context = {
		allTools: [{ name: "read", sourceInfo: { source: "builtin" } }],
		activeToolNames: ["read", "github_search", "github_delete"],
		mcpSelections: [
			{ name: "github_search", selector: "github/search" },
			{ name: "github_delete", selector: "github/delete" },
		],
	};
	const all = inheritance.selectParentTools(context);
	assert.deepEqual(all.mcpDirectTools.sort(), ["github/delete", "github/search"]);
	assert.equal(all.tools.includes("github_search"), false, "MCP tools travel as selectors, not as allowlist names");
	const filtered = inheritance.selectParentTools(context, ["github_delete"]);
	assert.deepEqual(filtered.mcpDirectTools, ["github/search"]);
});

test("a launch without an agent runs the default writable agent; present names are never rewritten", () => {
	const { withDefaultAgent, DEFAULT_SUBAGENT_NAME } = defaultAgent;
	assert.equal(DEFAULT_SUBAGENT_NAME, "writable");
	assert.equal(withDefaultAgent({ task: "do it" }).agent, "writable");

	const named = { agent: "readonly", task: "look" };
	assert.equal(withDefaultAgent(named), named, "an explicit agent keeps the same object");
	const unknown = { agent: "reviwer", task: "look" };
	assert.equal(withDefaultAgent(unknown), unknown, "a mistyped name must reach the unknown-agent error, not become writable");

	for (const params of [
		{ task: "x", action: "list" },
		{ task: "x", resume: "run-1" },
		{ task: "x", workflowScript: "return 1" },
		{ task: "x", chain: [{ agent: "readonly", task: "a" }] },
		{ task: "x", tasks: [{ agent: "readonly", task: "a" }] },
		{ action: "list" },
		{ task: "   " },
	]) {
		assert.equal(withDefaultAgent(params), params, `must not default ${JSON.stringify(params)}`);
	}
});

test("an empty-body agent still tags the child session with its active_agent marker", () => {
	const launch = childLaunch.buildInProcessChildLaunch({
		cwd: root,
		childAgentName: "writable",
		childIndex: 0,
		sessionEnabled: false,
		inheritProjectContext: true,
		inheritGlobalContext: false,
		inheritSkills: false,
		systemPrompt: "",
		systemPromptMode: "append",
		host: "parent",
	});
	assert.match(launch.session.appendSystemPrompt ?? "", /^<active_agent name="writable"\/>/);
});

test("MCP selector resolution yields nothing when no MCP server is configured", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-mcp-none-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	});
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	assert.deepEqual(mcpAllowlist.resolveMcpSelectorsForActiveTools(["read", "github_search"], dir), []);
});
