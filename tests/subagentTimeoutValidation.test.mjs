import "./helpers/piFixtureResolver.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const root = mkdtempSync(join(tmpdir(), "pideck-timeout-validation-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

const { discoverAgents } = await import("../resources/extensions/pideck-q-subagents/src/agents/agents.ts");
const { handleCreate } = await import("../resources/extensions/pideck-q-subagents/src/agents/agent-management.ts");
const { registerRuntimeAgent, listRuntimeAgentConfigs } = await import("../resources/extensions/pideck-q-subagents/src/agents/runtime-agent-registry.ts");
const MAX_TIMER_DELAY_MS = 2_147_483_647;

for (const field of ["timeoutMs", "toolTimeoutMs"]) {
	test(`${field} frontmatter accepts the longest safe timer and rejects overflow`, () => {
		const cwd = join(root, field);
		const agentsDir = join(cwd, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		for (const [name, value] of [["safe-timeout", MAX_TIMER_DELAY_MS], ["overflow-timeout", MAX_TIMER_DELAY_MS + 1]]) {
			writeFileSync(join(agentsDir, `${name}.md`), `---\nname: ${name}\ndescription: Timeout validation fixture\n${field}: ${value}\n---\nRead the requested file.\n`);
		}
		const discovered = discoverAgents(cwd, "project");
		const expectedField = field === "timeoutMs" ? "defaultTimeoutMs" : "defaultToolTimeoutMs";
		assert.equal(discovered.agents.find((agent) => agent.name === "safe-timeout")?.[expectedField], MAX_TIMER_DELAY_MS);
		assert.equal(discovered.agents.some((agent) => agent.name === "overflow-timeout"), false);
		assert.match(JSON.stringify(discovered.agentDiagnostics), /2147483647/);
	});
}

for (const field of ["defaultTimeoutMs", "defaultToolTimeoutMs"]) {
	test(`runtime registration rejects overflowing ${field} without retaining an agent`, () => {
		const pi = { on() {}, registerTool() {} };
		const definition = { description: "Timeout validation fixture", systemPrompt: "Read the requested file." };
		assert.throws(() => registerRuntimeAgent({ pi, name: "overflow-timeout", definition: { ...definition, [field]: MAX_TIMER_DELAY_MS + 1 } }), /2147483647/);
		assert.deepEqual(listRuntimeAgentConfigs(pi), []);
		const registration = registerRuntimeAgent({ pi, name: "safe-timeout", definition: { ...definition, [field]: MAX_TIMER_DELAY_MS } });
		try { assert.equal(listRuntimeAgentConfigs(pi)[0][field], MAX_TIMER_DELAY_MS); }
		finally { registration.dispose(); }
	});
}

test("agent creation refuses an overflowing run deadline before writing its definition", () => {
	const cwd = join(root, "management");
	mkdirSync(cwd, { recursive: true });
	const result = handleCreate({ config: { name: "overflow-timeout", description: "Timeout validation fixture", scope: "project", timeoutMs: MAX_TIMER_DELAY_MS + 1 } }, { cwd, modelRegistry: { getAvailable: () => [] } });
	assert.equal(result.isError, true);
	assert.match(result.content.map((part) => part.text ?? "").join("\n"), /2147483647/);
	assert.equal(existsSync(join(cwd, ".pi", "agents", "overflow-timeout.md")), false);
});
