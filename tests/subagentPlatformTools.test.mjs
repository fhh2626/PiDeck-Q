import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadSubagentCatalog, parseAgentFrontmatter } from "../resources/extensions/pideck-q-change-pi-prompt/subagentCatalog.ts";
import { mapAgentToolsToHostShells } from "../resources/extensions/pideck-q-change-pi-prompt/childShellPolicy.ts";

const agentsDir = new URL("../resources/extensions/pideck-q-subagents/agents/", import.meta.url);

const catalog = loadSubagentCatalog(fileURLToPath(new URL("../resources/extensions/pideck-q-subagents", import.meta.url)));

test("parseAgentFrontmatter reads hostShell correctly and defaults to false", () => {
	const entryTrue = parseAgentFrontmatter("---\nname: test-agent\ntools: read\nhostShell: true\n---\nPrompt", "test.md");
	assert.ok(entryTrue);
	assert.equal(entryTrue.hostShell, true);

	const entryFalse = parseAgentFrontmatter("---\nname: test-agent\ntools: read\nhostShell: false\n---\nPrompt", "test.md");
	assert.ok(entryFalse);
	assert.equal(entryFalse.hostShell, false);

	const entryMissing = parseAgentFrontmatter("---\nname: test-agent\ntools: read\n---\nPrompt", "test.md");
	assert.ok(entryMissing);
	assert.equal(entryMissing.hostShell, false);

	const entryInvalid = parseAgentFrontmatter("---\nname: test-agent\ntools: read\nhostShell: maybe\n---\nPrompt", "test.md");
	assert.ok(entryInvalid);
	assert.equal(entryInvalid.hostShell, false);
});

for (const name of ["delegate", "oracle", "worker", "reviewer", "scout"]) {
	test(`${name} has fixed non-shell base tool allowlist and hostShell: true`, () => {
		const agent = catalog.agents.get(name);
		assert.ok(agent, `${name} must exist in catalog`);
		assert.equal(agent.hostShell, true, `${name} must declare hostShell: true`);

		// Base tools must not require platform-dependent search or shell tools
		assert.ok(Array.isArray(agent.tools), `${name} must declare a tool list`);
		assert.ok(agent.tools.includes("read"), `${name} must include read`);
		assert.equal(agent.tools.includes("grep"), false, `${name} must not declare grep`);
		assert.equal(agent.tools.includes("find"), false, `${name} must not declare find`);
		assert.equal(agent.tools.includes("ls"), false, `${name} must not declare ls`);
		assert.equal(agent.tools.includes("bash"), false, `${name} must not declare fixed bash`);
		assert.equal(agent.tools.includes("powershell"), false, `${name} must not declare fixed powershell`);

		// Markdown frontmatter verification
		const filePath = fileURLToPath(new URL(`${name}.md`, agentsDir));
		const source = readFileSync(filePath, "utf8");
		const frontmatter = source.split("---", 3)[1];
		assert.ok(frontmatter, `${name} must have agent frontmatter`);
		assert.match(frontmatter, /^tools:/m);
		assert.match(frontmatter, /^hostShell:\s*true$/m);
		assert.doesNotMatch(frontmatter, /\b(?:grep|find|ls)\b/i);
	});
}

test("oracle and reviewer enforce read-only role boundaries without edit or write tools", () => {
	for (const name of ["oracle", "reviewer"]) {
		const agent = catalog.agents.get(name);
		assert.ok(agent);
		assert.equal(agent.tools.includes("edit"), false, `${name} must not declare edit`);
		assert.equal(agent.tools.includes("write"), false, `${name} must not declare write`);

		const filePath = fileURLToPath(new URL(`${name}.md`, agentsDir));
		const source = readFileSync(filePath, "utf8");
		const frontmatter = source.split("---", 3)[1];
		assert.match(frontmatter, /excludeTools:.*edit/);
		assert.match(frontmatter, /excludeTools:.*write/);
	}
});

test("delegate and worker retain necessary implementation tools", () => {
	for (const name of ["delegate", "worker"]) {
		const agent = catalog.agents.get(name);
		assert.ok(agent);
		assert.ok(agent.tools.includes("read"), `${name} must include read`);
		assert.ok(agent.tools.includes("edit"), `${name} must include edit`);
		assert.ok(agent.tools.includes("write"), `${name} must include write`);
		assert.ok(agent.tools.includes("contact_supervisor"), `${name} must include contact_supervisor`);
	}
});

test("scout retains write for handoff output but does not declare edit", () => {
	const scout = catalog.agents.get("scout");
	assert.ok(scout);
	assert.ok(scout.tools.includes("read"), "scout must include read");
	assert.ok(scout.tools.includes("write"), "scout must include write for output");
	assert.ok(scout.tools.includes("contact_supervisor"), "scout must include contact_supervisor");
	assert.equal(scout.tools.includes("edit"), false, "scout must not declare edit");
});

test("mapAgentToolsToHostShells resolves platform shells accurately for hostShell agents", () => {
	const baseTools = ["read", "contact_supervisor"];

	// Windows with only PowerShell
	const winOnly = mapAgentToolsToHostShells({
		declaredTools: baseTools,
		hostShell: true,
		hostShells: { bash: false, powershell: true },
	});
	assert.deepEqual(winOnly, ["read", "contact_supervisor", "powershell"]);

	// Linux with only Bash
	const linuxOnly = mapAgentToolsToHostShells({
		declaredTools: baseTools,
		hostShell: true,
		hostShells: { bash: true, powershell: false },
	});
	assert.deepEqual(linuxOnly, ["read", "contact_supervisor", "bash"]);

	// Both shells available
	const both = mapAgentToolsToHostShells({
		declaredTools: baseTools,
		hostShell: true,
		hostShells: { bash: true, powershell: true },
	});
	assert.deepEqual(both, ["read", "contact_supervisor", "bash", "powershell"]);

	// Neither shell available
	const neither = mapAgentToolsToHostShells({
		declaredTools: baseTools,
		hostShell: true,
		hostShells: { bash: false, powershell: false },
	});
	assert.deepEqual(neither, ["read", "contact_supervisor"]);

	// Agent without hostShell does not get shells added
	const noHostShell = mapAgentToolsToHostShells({
		declaredTools: baseTools,
		hostShell: false,
		hostShells: { bash: true, powershell: true },
	});
	assert.deepEqual(noHostShell, ["read", "contact_supervisor"]);
});
