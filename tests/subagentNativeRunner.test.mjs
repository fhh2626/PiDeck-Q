import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import "./helpers/piFixtureResolver.mjs";

const { discoverAgents, clearAgentDiscoveryCache } = await import("../resources/extensions/pideck-q-subagents/src/agents/agents.ts");
const { handleCreate } = await import("../resources/extensions/pideck-q-subagents/src/agents/agent-management.ts");
const { registerRuntimeAgent } = await import("../resources/extensions/pideck-q-subagents/src/agents/runtime-agent-registry.ts");

/** Each boundary reads its own isolated definitions rather than the developer's Pi configuration. */
function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pideck-native-runners-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	mkdirSync(cwd);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	clearAgentDiscoveryCache();
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		clearAgentDiscoveryCache();
		rmSync(root, { recursive: true, force: true });
	});
	return { agentDir, cwd };
}

for (const runner of [{ type: "external-cli", command: "never-launch" }, { type: "external-job", provider: "retired-provider" }]) {
	test(`file-defined ${runner.type} stays invalid instead of becoming a Pi child`, (t) => {
		const { agentDir, cwd } = fixture(t);
		writeFileSync(join(agentDir, "agents", "legacy.md"), `---\nname: legacy\ndescription: Old runner\nrunner: ${JSON.stringify(runner)}\n---\nDo work.\n`);
		const result = discoverAgents(cwd, "user");
		assert.equal(result.agents.some((agent) => agent.name === "legacy"), false);
		assert.ok(result.agentDiagnostics?.some((entry) => /supports only runner.type='pi'/.test(entry.error)));
	});

	test(`agent authoring rejects ${runner.type} without saving a definition`, (t) => {
		const { agentDir, cwd } = fixture(t);
		const result = handleCreate({ config: { name: "retired", description: "Rejected runner", runner } }, { cwd });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /supports only runner.type='pi'/);
		assert.equal(existsSync(join(agentDir, "agents", "retired.md")), false);
	});

	test(`runtime registration rejects ${runner.type}`, () => {
		assert.throws(() => registerRuntimeAgent({
			pi: { on() {}, registerTool() {} }, name: "retired-runtime",
			definition: { description: "Rejected runtime runner", runner },
		}), /supports only runner.type='pi'/);
	});
}

test("legacy async defaults load as foreground while native runner metadata is preserved", (t) => {
	const { agentDir, cwd } = fixture(t);
	writeFileSync(join(agentDir, "agents", "native.md"), '---\nname: native\ndescription: Native runner\nrunner: {"type":"pi"}\nasync: true\n---\nRead the project.\n');
	const result = discoverAgents(cwd, "user");
	const agent = result.agents.find((entry) => entry.name === "native");
	assert.ok(agent);
	assert.deepEqual(agent.runner, { type: "pi" });
	assert.equal(agent.defaultAsync, false);
});

test("new agent definitions cannot restore an independent background default", (t) => {
	const { agentDir, cwd } = fixture(t);
	const result = handleCreate({ config: { name: "background", description: "Rejected default", async: true } }, { cwd });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /foreground/);
	assert.equal(existsSync(join(agentDir, "agents", "background.md")), false);
	assert.throws(() => registerRuntimeAgent({
		pi: { on() {}, registerTool() {} }, name: "background-runtime",
		definition: { description: "Rejected default", defaultAsync: true },
	}), /foreground execution only/);
});
