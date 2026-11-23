import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";

/**
 * Single-owner guard for the C++ channel registry (AGENTS.md "IPC 按域注册").
 *
 * `ChannelRegistry` is two `QHash`es: `invoke` prefers the async table and otherwise
 * resolves the sync one, so registering the same channel twice silently picks a winner
 * by table/order instead of failing. That is how `config:get-settings`,
 * `config:save-settings` and `extensions:list` ended up owned by `AppChannels` *and*
 * their domain module, with the App copy reading a different directory — a registration
 * reorder would have switched the data source with no test failing.
 *
 * A runtime inventory cannot see the shadowed copy (it collapses into one map key), so
 * the only place the duplicate is observable is the registration site itself.
 */

const ROOT = "native/backend";

function cppFiles(directory) {
	const files = [];
	for (const entry of readdirSync(directory)) {
		const full = join(directory, entry);
		if (statSync(full).isDirectory()) files.push(...cppFiles(full));
		else if (entry.endsWith(".cpp")) files.push(full);
	}
	return files;
}

/** `{channel, file, line}` for every `registry.add(...)`/`addAsync(...)` literal. */
function registrations() {
	const found = [];
	for (const file of cppFiles(ROOT)) {
		const lines = readFileSync(file, "utf8").split("\n");
		lines.forEach((line, index) => {
			const match = line.match(/registry\.add(?:Async)?\(\s*QStringLiteral\("([^"]+)"\)/);
			if (!match) return;
			found.push({ channel: match[1], file: relative(process.cwd(), file), line: index + 1 });
		});
	}
	return found;
}

describe("native2 channel registry ownership", () => {
	test("no channel is registered twice across native/backend", () => {
		const all = registrations();
		assert.ok(all.length > 200, `expected the full channel surface, saw ${all.length}`);
		const byChannel = new Map();
		for (const entry of all) {
			const owners = byChannel.get(entry.channel) ?? [];
			owners.push(entry);
			byChannel.set(entry.channel, owners);
		}
		const duplicates = [...byChannel.entries()]
			.filter(([, owners]) => owners.length > 1)
			.map(([channel, owners]) => `${channel}: ${owners.map((owner) => `${owner.file}:${owner.line}`).join(", ")}`);
		assert.deepEqual(duplicates, [], `duplicate channel registrations:\n${duplicates.join("\n")}`);
	});

	test("the config and extension surface is owned by its domain module", () => {
		const ownership = new Map(registrations().map((entry) => [entry.channel, entry.file.replaceAll("\\", "/")]));
		// Each of these had a second copy in AppChannels.cpp; the domain module is the
		// owner that reads `services.configDir` / the extension manager.
		assert.equal(ownership.get("config:get-settings"), "native/backend/domain/ConfigChannels.cpp");
		assert.equal(ownership.get("config:save-settings"), "native/backend/domain/ConfigChannels.cpp");
		assert.equal(ownership.get("extensions:list"), "native/backend/domain/ExtensionChannels.cpp");
	});
});
