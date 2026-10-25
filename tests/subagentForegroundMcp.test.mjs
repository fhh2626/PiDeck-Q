import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import "./helpers/piFixtureResolver.mjs";

// Pi-hosted packages come from the latest-Pi fixture, so load sources only after the resolver is active.
const shared = "../resources/extensions/pideck-q-subagents/src/runs/shared";
const { createForegroundMcpHook } = await import(`${shared}/foreground-mcp.ts`);
const { buildInProcessChildLaunch } = await import(`${shared}/child-launch.ts`);
const { computeMcpServerHash } = await import(`${shared}/mcp-direct-tool-allowlist.ts`);
const { evaluateChildToolDiagnostic } = await import(`${shared}/child-runtime-config.ts`);

/** In-memory JSON-RPC transport: exercises the SDK's real MCP connection/tool/cleanup path. */
function transportFor(server, calls) {
	const listeners = { message: new Set(), error: new Set(), close: new Set() };
	const subscribe = (key, callback) => { listeners[key].add(callback); return () => listeners[key].delete(callback); };
	return {
		closed: false,
		async start() {},
		onMessage: (callback) => subscribe("message", callback),
		onError: (callback) => subscribe("error", callback),
		onClose: (callback) => subscribe("close", callback),
		async close() { this.closed = true; for (const callback of listeners.close) callback(); },
		async send(message) {
			if (message.id === undefined) return;
			let result;
			if (message.method === "initialize") {
				result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: server, version: "1" } };
			} else if (message.method === "tools/list") {
				result = { tools: ["search", "delete"].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })) };
			} else if (message.method === "tools/call") {
				calls.push({ server, ...message.params });
				result = { content: [{ type: "text", text: `${server}/${message.params.name}` }] };
			} else throw new Error(`Unexpected request ${message.method}`);
			queueMicrotask(() => { for (const callback of listeners.message) callback({ jsonrpc: "2.0", id: message.id, result }); });
		},
	};
}

/** Minimal tool registry and lifecycle dispatcher, without network or a real model. */
function childRegistry(cwd) {
	const handlers = new Map();
	const tools = new Map();
	let active = ["read"];
	const ctx = { cwd, signal: new AbortController().signal, hasUI: false, ui: { notify() {} }, modelRegistry: { async getApiKeyForProvider() {} } };
	const api = {
		on(event, callback) { const entries = handlers.get(event) ?? []; entries.push(callback); handlers.set(event, entries); return () => {}; },
		registerTool(tool) { tools.set(tool.name, tool); if (tool.exposure !== "hidden" && !active.includes(tool.name)) active.push(tool.name); },
		registerCommand() { throw new Error("Child MCP must not install configuration commands"); },
		registerToolRenderer() {},
		getMcpServers: () => [{ name: "ambient", config: { command: "must-not-run" }, extensionPath: "ambient" }],
		getAllTools: () => [...tools.values()],
		getActiveTools: () => active,
		setActiveTools: (names) => { active = names; },
	};
	return { api, tools, ctx, async emit(event, value = {}) { for (const callback of handlers.get(event) ?? []) await callback({ type: event, ...value }, ctx); } };
}

test("foreground MCP registers and executes only the selected parent tools and closes its SDK transport", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-foreground-mcp-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const calls = [];
	const transports = [];
	const inheritedEnv = process.env.MCP_DIRECT_TOOLS;
	const child = childRegistry(dir);
	const hook = createForegroundMcpHook({ mcpServers: { docs: { command: "fake-docs" }, unused: { command: "must-not-run" } } }, [
		{ name: "docs_search", selector: "docs/search" },
	], { logPath: join(dir, "mcp.log"), createTransport(entry) { const transport = transportFor(entry.name, calls); transports.push(transport); return transport; } });
	await hook.factory(child.api);
	t.after(() => child.emit("session_shutdown"));
	await child.emit("session_start");
	await child.emit("before_agent_start", { systemPromptOptions: { sections: {} } });
	assert.deepEqual([...child.tools.keys()], ["docs_search"]);
	assert.equal(transports.length, 1, "neither ambient nor unselected config servers connect");
	assert.equal(evaluateChildToolDiagnostic({ requiredTools: ["docs_search"], mcpDirectTools: ["docs_search"] }, child.api.getActiveTools()), undefined);
	assert.deepEqual(evaluateChildToolDiagnostic({ requiredTools: ["docs_missing"], mcpDirectTools: ["docs_missing"] }, child.api.getActiveTools()).missing, ["docs_missing"], "unavailable required MCP tools still fail closed");
	const result = await child.tools.get("docs_search").execute("call-1", {}, child.ctx.signal, undefined, child.ctx);
	assert.equal(result.content[0].text, "docs/search");
	assert.deepEqual(calls.map((call) => [call.server, call.name]), [["docs", "search"]]);
	assert.equal(process.env.MCP_DIRECT_TOOLS, inheritedEnv, "the parent process environment is untouched");
	await child.emit("session_shutdown");
	assert.equal(transports[0].closed, true);
});

test("concurrent foreground MCP children keep disjoint selection and connections", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-foreground-mcp-two-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const config = { mcpServers: { docs: { command: "fake-docs" } } };
	const calls = [];
	const transports = [];
	const children = [childRegistry(dir), childRegistry(dir)];
	const hooks = ["search", "delete"].map((name) => createForegroundMcpHook(config, [{ name: `docs_${name}`, selector: `docs/${name}` }], {
		logPath: join(dir, `${name}.log`), createTransport(entry) { const transport = transportFor(entry.name, calls); transports.push(transport); return transport; },
	}));
	t.after(async () => { for (const child of children) await child.emit("session_shutdown"); });
	await Promise.all(children.map(async (child, i) => { await hooks[i].factory(child.api); await child.emit("session_start"); await child.emit("before_agent_start", { systemPromptOptions: { sections: {} } }); }));
	assert.deepEqual([...children[0].tools.keys()], ["docs_search"]);
	assert.deepEqual([...children[1].tools.keys()], ["docs_delete"]);
	await children[0].emit("session_shutdown");
	assert.equal(transports[0].closed, true);
	assert.equal(transports[1].closed, false);
	await children[1].tools.get("docs_delete").execute("call-2", {}, children[1].ctx.signal, undefined, children[1].ctx);
	assert.equal(calls.at(-1).name, "delete");
});

test("the foreground launch wires its session-local MCP hook after blacklist/ceiling resolution", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-mcp-launch-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(dir, { recursive: true, force: true }); });
	const definition = { command: "fake-docs" };
	writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { "foreground-test-docs": definition } }));
	writeFileSync(join(dir, "mcp-cache.json"), JSON.stringify({ version: 1, servers: { "foreground-test-docs": { configHash: computeMcpServerHash(definition), cachedAt: Date.now(), tools: [{ name: "search" }, { name: "delete" }] } } }));
	const launchInput = {
		cwd: dir, childAgentName: "readonly", childIndex: 0, sessionEnabled: false,
		inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
		host: "parent", tools: ["read"], mcpDirectTools: ["foreground-test-docs"],
		excludeTools: ["foreground-test-docs_delete"],
	};
	const launch = buildInProcessChildLaunch(launchInput);
	const restricted = buildInProcessChildLaunch({ ...launchInput, excludeTools: [], capabilityCeiling: {
		version: 1, allowedTools: ["read", "foreground-test-docs_search"], denyExtensions: false, sources: ["test"],
	} });
	assert.deepEqual(restricted.toolPlan.effectiveMcpTools, ["foreground-test-docs_search"], "capability ceilings cannot be widened by the SDK provider");
	const extensionsDenied = buildInProcessChildLaunch({ ...launchInput, capabilityCeiling: {
		version: 1, allowedTools: ["read"], denyExtensions: true, sources: ["test"],
	} });
	assert.ok(!extensionsDenied.session.hooks.some((hook) => hook.name === "pi-subagents:foreground-mcp"));
	assert.equal(launch.session.ambientExtensions, false);
	assert.equal(launch.session.processEnv?.MCP_DIRECT_TOOLS, undefined, "foreground MCP must not use process-global adapter env");
	assert.ok(launch.session.hooks.some((hook) => hook.name === "pi-subagents:foreground-mcp"), "MCP tools must have an actual provider, not just an allowlist");
	assert.ok(launch.config.requiredTools.includes("foreground-test-docs_search"));
	assert.ok(!launch.config.requiredTools.includes("foreground-test-docs_delete"));
	assert.deepEqual(launch.toolPlan.effectiveMcpSelections, [{ name: "foreground-test-docs_search", selector: "foreground-test-docs/search" }]);
});

test("unsupported adapter-only transport settings fail explicitly rather than dropping required tools", () => {
	assert.throws(() => createForegroundMcpHook({ mcpServers: { docs: { command: "fake", socket: "/socket" } } }, [{ name: "docs_search", selector: "docs/search" }]), /unsupported setting 'socket'/);
});
test("foreground HTTP config preserves adapter interpolation and literal bearer/header values", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-mcp-http-config-"));
	const previous = process.env.PIDECK_MCP_TEST_HOST;
	process.env.PIDECK_MCP_TEST_HOST = "docs";
	t.after(() => { if (previous === undefined) delete process.env.PIDECK_MCP_TEST_HOST; else process.env.PIDECK_MCP_TEST_HOST = previous; rmSync(dir, { recursive: true, force: true }); });
	const child = childRegistry(dir);
	let received;
	const hook = createForegroundMcpHook({ mcpServers: { docs: {
		url: "https://example.invalid/{env:PIDECK_MCP_TEST_HOST}/mcp",
		headers: { "X-Literal": "!!literal-dollar$word" }, bearerToken: "literal$token", auth: "bearer",
	} } }, [{ name: "docs_search", selector: "docs/search" }], {
		logPath: join(dir, "mcp.log"), createTransport(entry) { received = entry.config; return transportFor(entry.name, []); },
	});
	await hook.factory(child.api);
	t.after(() => child.emit("session_shutdown"));
	await child.emit("session_start");
	await child.emit("before_agent_start", { systemPromptOptions: { sections: {} } });
	assert.equal(received.url, "https://example.invalid/docs/mcp");
	assert.equal(received.headers.Authorization, "Bearer literal$$token");
	assert.equal(received.headers["X-Literal"], "$!literal-dollar$$word", "a literal must not turn into a credential shell command");
	assert.deepEqual([...child.tools.keys()], ["docs_search"]);
});