import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const inheritance = await import(pathToFileURL(join(root, "resources/extensions/pideck-q-subagents/src/agents/parent-tool-inheritance.ts")).href);
const agentsModule = await import(pathToFileURL(join(root, "resources/extensions/pideck-q-subagents/src/agents/agents.ts")).href);

const { selectParentTools, applyParentToolInheritance, readParentToolContext } = inheritance;

/** Builds real provider files so existence checks behave like a loaded extension. */
function createProviders() {
	const dir = mkdtempSync(join(tmpdir(), "pideck-parent-tools-"));
	const ownRoot = join(dir, "pideck-q-subagents");
	mkdirSync(join(ownRoot, "dist"), { recursive: true });
	const make = (...segments) => {
		const target = join(dir, ...segments);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, "// provider", "utf8");
		return target;
	};
	return {
		dir,
		ownRoot,
		ownEntry: make("pideck-q-subagents", "dist", "index.js"),
		todoProvider: make("ext", "todo.ts"),
		searchProvider: make("ext", "web-search.ts"),
		mcpProvider: make("agent", "npm", "node_modules", "pi-mcp-adapter", "index.ts"),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

test("selectParentTools copies builtins by name and extension tools with their provider paths", (t) => {
	const p = createProviders();
	t.after(p.cleanup);
	const selection = selectParentTools({
		ownPackageRoot: p.ownRoot,
		activeToolNames: ["read", "bash", "todo", "web_search"],
		allTools: [
			{ name: "read", sourceInfo: { source: "builtin", path: "<builtin:read>" } },
			{ name: "bash", sourceInfo: { source: "builtin", path: "<builtin:bash>" } },
			{ name: "todo", sourceInfo: { source: "local", path: p.todoProvider } },
			{ name: "web_search", sourceInfo: { source: "local", path: p.searchProvider } },
		],
	});
	assert.deepEqual(selection.tools, ["read", "bash", "todo", "web_search", "contact_supervisor"]);
	assert.deepEqual(selection.extensionPaths, [p.todoProvider, p.searchProvider]);
	assert.deepEqual(selection.skipped, []);
});

test("selectParentTools only mirrors active tools, never registered-but-inactive ones", (t) => {
	const p = createProviders();
	t.after(p.cleanup);
	const selection = selectParentTools({
		ownPackageRoot: p.ownRoot,
		activeToolNames: ["read"],
		allTools: [
			{ name: "read", sourceInfo: { source: "builtin", path: "<builtin:read>" } },
			{ name: "todo", sourceInfo: { source: "local", path: p.todoProvider } },
		],
	});
	assert.equal(selection.tools.includes("todo"), false);
	assert.deepEqual(selection.extensionPaths, []);
});

test("selectParentTools never copies fan-out, subagent-owned or MCP-adapter tools and reports why", (t) => {
	const p = createProviders();
	t.after(p.cleanup);
	const selection = selectParentTools({
		ownPackageRoot: p.ownRoot,
		activeToolNames: ["subagent", "bg_wait", "github_search", "orphan_tool", "todo"],
		allTools: [
			{ name: "subagent", sourceInfo: { source: "local", path: p.ownEntry } },
			{ name: "bg_wait", sourceInfo: { source: "local", path: p.ownEntry } },
			{ name: "github_search", sourceInfo: { source: "npm", path: p.mcpProvider } },
			{ name: "orphan_tool", sourceInfo: { source: "local", path: join(p.dir, "missing", "gone.ts") } },
			{ name: "todo", sourceInfo: { source: "local", path: p.todoProvider } },
		],
	});
	assert.deepEqual(selection.tools, ["todo", "contact_supervisor"]);
	assert.deepEqual(selection.extensionPaths, [p.todoProvider]);
	assert.deepEqual(
		selection.skipped.map((entry) => `${entry.name}:${entry.reason}`).sort(),
		[
			"bg_wait:subagent-owned",
			"github_search:mcp-adapter",
			"orphan_tool:no-loadable-provider",
			"subagent:subagent-owned",
		],
	);
});

test("selectParentTools lists a shared provider once and keeps contact_supervisor without duplicates", (t) => {
	const p = createProviders();
	t.after(p.cleanup);
	const selection = selectParentTools({
		ownPackageRoot: p.ownRoot,
		activeToolNames: ["todo", "todo_list", "contact_supervisor"],
		allTools: [
			{ name: "todo", sourceInfo: { source: "local", path: p.todoProvider } },
			{ name: "todo_list", sourceInfo: { source: "local", path: p.todoProvider } },
		],
	});
	assert.deepEqual(selection.extensionPaths, [p.todoProvider]);
	assert.equal(selection.tools.filter((name) => name === "contact_supervisor").length, 1);
});

test("selectParentTools blacklist drops excluded tools and loads a provider only while a kept tool needs it", (t) => {
	const p = createProviders();
	t.after(p.cleanup);
	const context = {
		ownPackageRoot: p.ownRoot,
		activeToolNames: ["read", "bash", "todo", "todo_list", "web_search"],
		allTools: [
			{ name: "read", sourceInfo: { source: "builtin", path: "<builtin:read>" } },
			{ name: "bash", sourceInfo: { source: "builtin", path: "<builtin:bash>" } },
			{ name: "todo", sourceInfo: { source: "local", path: p.todoProvider } },
			{ name: "todo_list", sourceInfo: { source: "local", path: p.todoProvider } },
			{ name: "web_search", sourceInfo: { source: "local", path: p.searchProvider } },
		],
	};
	// Partially excluded provider stays loaded for the tool that is still allowed.
	const partial = selectParentTools(context, ["bash", "todo"]);
	assert.deepEqual(partial.tools, ["read", "todo_list", "web_search", "contact_supervisor"]);
	assert.deepEqual(partial.extensionPaths, [p.todoProvider, p.searchProvider]);
	// Fully excluded provider is not loaded at all, and contact_supervisor can be blacklisted too.
	const full = selectParentTools(context, ["web_search", " contact_supervisor "]);
	assert.deepEqual(full.extensionPaths, [p.todoProvider]);
	assert.equal(full.tools.includes("web_search"), false);
	assert.equal(full.tools.includes("contact_supervisor"), false);
	assert.ok(full.skipped.some((entry) => entry.name === "web_search" && entry.reason === "excluded"));
});

function agent(overrides = {}) {
	return {
		name: "delegate",
		description: "test agent",
		systemPrompt: "",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritGlobalContext: false,
		inheritSkills: false,
		source: "builtin",
		filePath: "delegate.md",
		...overrides,
	};
}

test("applyParentToolInheritance leaves unflagged agents untouched and never reads the host", () => {
	const agents = [agent({ tools: ["read"] })];
	const result = applyParentToolInheritance(agents, () => {
		throw new Error("parent tools must not be read when no agent asks for them");
	});
	assert.equal(result, agents);
});

test("applyParentToolInheritance resolves flagged agents and merges provider paths into existing ones", (t) => {
	const p = createProviders();
	t.after(p.cleanup);
	const keep = agent({ name: "worker", tools: ["read", "edit"] });
	const flagged = agent({ inheritParentTools: true, mcpDirectTools: ["x/y"], subagentOnlyExtensions: ["/managed/ext.ts"] });
	const [worker, delegate] = applyParentToolInheritance([keep, flagged], () => ({
		ownPackageRoot: p.ownRoot,
		activeToolNames: ["read", "todo"],
		allTools: [
			{ name: "read", sourceInfo: { source: "builtin", path: "<builtin:read>" } },
			{ name: "todo", sourceInfo: { source: "local", path: p.todoProvider } },
		],
	}));
	assert.equal(worker, keep);
	assert.deepEqual(delegate.tools, ["read", "todo", "contact_supervisor"]);
	assert.deepEqual(delegate.subagentOnlyExtensions, ["/managed/ext.ts", p.todoProvider]);
	assert.equal(delegate.inheritParentTools, undefined);
	assert.equal(delegate.mcpDirectTools, undefined);
});

test("applyParentToolInheritance applies each agent's own excludeTools blacklist", (t) => {
	const p = createProviders();
	t.after(p.cleanup);
	const context = {
		ownPackageRoot: p.ownRoot,
		activeToolNames: ["read", "bash", "todo"],
		allTools: [
			{ name: "read", sourceInfo: { source: "builtin", path: "<builtin:read>" } },
			{ name: "bash", sourceInfo: { source: "builtin", path: "<builtin:bash>" } },
			{ name: "todo", sourceInfo: { source: "local", path: p.todoProvider } },
		],
	};
	const [strict, open] = applyParentToolInheritance([
		agent({ name: "strict", inheritParentTools: true, excludeTools: ["bash", "todo"] }),
		agent({ name: "open", inheritParentTools: true }),
	], () => context);
	assert.deepEqual(strict.tools, ["read", "contact_supervisor"]);
	assert.equal(strict.subagentOnlyExtensions, undefined);
	assert.deepEqual(open.tools, ["read", "bash", "todo", "contact_supervisor"]);
});

test("applyParentToolInheritance fails closed to an empty allowlist when parent tools are unavailable", () => {
	const [resolved] = applyParentToolInheritance([agent({ inheritParentTools: true })], () => undefined);
	assert.deepEqual(resolved.tools, []);
	assert.equal(resolved.inheritParentTools, undefined);
});

test("readParentToolContext returns undefined instead of throwing when the session is stale", () => {
	const context = readParentToolContext({
		getAllTools: () => { throw new Error("stale"); },
		getActiveTools: () => [],
	});
	assert.equal(context, undefined);
});

test("a tools:'parent' settings override marks the agent and later explicit overrides clear it", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-parent-override-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		agentsModule.clearAgentDiscoveryCache?.();
		rmSync(dir, { recursive: true, force: true });
	});
	const agentDir = join(dir, "agent");
	const projectDir = join(dir, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		subagents: { agentOverrides: { delegate: { tools: "parent", excludeTools: ["bash"] } } },
	}), "utf8");
	agentsModule.clearAgentDiscoveryCache?.();

	const { agents } = agentsModule.discoverAgents(projectDir, "user");
	const delegate = agents.find((candidate) => candidate.name === "delegate");
	assert.ok(delegate, "builtin delegate must be discoverable");
	assert.equal(delegate.inheritParentTools, true);
	// The blacklist travels with the same override and is what the launch resolver consumes.
	assert.deepEqual(delegate.excludeTools, ["bash"]);
	// Unresolved marker must fail closed (no tools), never fall back to the default builtin set.
	assert.deepEqual(delegate.tools, []);
	assert.equal(delegate.mcpDirectTools, undefined);

	// A narrower explicit list in the same file replaces the marker instead of stacking with it.
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		subagents: { agentOverrides: { delegate: { tools: ["read"] } } },
	}), "utf8");
	agentsModule.clearAgentDiscoveryCache?.();
	const explicit = agentsModule.discoverAgents(projectDir, "user").agents.find((candidate) => candidate.name === "delegate");
	assert.deepEqual(explicit.tools, ["read"]);
	assert.equal(explicit.inheritParentTools, undefined);
});
