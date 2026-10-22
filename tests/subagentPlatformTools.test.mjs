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

for (const name of ["readonly", "writable"]) {
	test(`${name} copies the parent's tools (tools: parent) and uses the host shell`, () => {
		const agent = catalog.agents.get(name);
		assert.ok(agent, `${name} must exist in catalog`);
		assert.equal(agent.hostShell, true, `${name} must declare hostShell: true`);
		assert.equal(agent.inheritParentTools, true, `${name} must declare tools: parent`);
		// No fixed list: the launcher copies the launching session's active tools at spawn time.
		assert.deepEqual(agent.tools, [], `${name} must not pin a tool list`);

		const source = readFileSync(fileURLToPath(new URL(`${name}.md`, agentsDir)), "utf8");
		const frontmatter = source.split("---", 3)[1];
		assert.ok(frontmatter, `${name} must have agent frontmatter`);
		assert.match(frontmatter, /^tools:\s*parent$/m);
		assert.match(frontmatter, /^hostShell:\s*true$/m);
		assert.match(frontmatter, /^defaultContext:\s*fork$/m);
		// Model and thinking are inherited from the parent: no pinned values.
		assert.doesNotMatch(frontmatter, /^(?:model|thinking):/m);
	});
}

test("only readonly blocks edit and write, and its prompt forbids file-modifying shell use", () => {
	const readonlySource = readFileSync(fileURLToPath(new URL("readonly.md", agentsDir)), "utf8");
	const readonlyFrontmatter = readonlySource.split("---", 3)[1];
	assert.match(readonlyFrontmatter, /^excludeTools:\s*edit,\s*write$/m);
	for (const phrase of [/git add\/commit\/checkout/, /package installs/, /output redirection/, /\brm\b/, /\bmv\b/]) {
		assert.match(readonlySource, phrase);
	}

	const writableSource = readFileSync(fileURLToPath(new URL("writable.md", agentsDir)), "utf8");
	assert.doesNotMatch(writableSource.split("---", 3)[1], /excludeTools/);
	// Empty body: the writable agent adds no prompt text of its own.
	assert.equal(writableSource.split("---").slice(2).join("---").trim(), "");
});

test("only the readonly and writable agents are bundled", () => {
	assert.deepEqual([...catalog.agents.keys()].sort(), ["readonly", "writable"]);
});

test("a tools: parent frontmatter marks the catalog entry and drops any listed tools", () => {
	const entry = parseAgentFrontmatter("---\nname: parent-agent\ntools: parent\n---\nPrompt", "x.md");
	assert.ok(entry);
	assert.equal(entry.inheritParentTools, true);
	assert.deepEqual(entry.tools, []);
	const listed = parseAgentFrontmatter("---\nname: listed-agent\ntools: read, edit\n---\nPrompt", "x.md");
	assert.ok(listed);
	assert.equal(listed.inheritParentTools, undefined);
	assert.deepEqual(listed.tools, ["read", "edit"]);
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
