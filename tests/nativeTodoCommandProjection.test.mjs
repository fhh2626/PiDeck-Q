import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createTodoHarness } from "./helpers/todoExtensionHarness.mjs";
import { childPathEnvironment, environmentPath, qtBinDirectory } from "./helpers/native2BackendHarness.mjs";
import { joinPathParts } from "./helpers/native2FakeProcess.mjs";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";

const pinned = process.env.PIDECK_TODO_COMMAND_TEST_EXECUTABLE;
const candidates = nativeBuildPaths("PiDeck-TodoCommandTest", { pinned });
const sources = ["native/tests/TodoCommandTest.cpp", "xmake.lua", ...[
	"native/backend/domain/runtime", "native/backend/domain/sessions",
].flatMap((directory) => readdirSync(directory).filter((name) => /\.(cpp|h)$/.test(name)).map((name) => `${directory}/${name}`))];
const executable = candidates.map((path) => resolve(path)).find((candidate) => existsSync(candidate)
	&& statSync(candidate).mtimeMs >= Math.max(...sources.map((path) => statSync(path).mtimeMs)));
const required = Boolean(pinned) || process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1";
if (required && !executable) throw new Error(`Missing or stale todo command test executable: ${candidates.join(", ")}`);
const skip = executable ? false : "Build PiDeck-TodoCommandTest to run the current production C++ projection";

/** The fixture invokes real C++ domain classes without requiring a pi process or logging service. */
function native(fixture) {
	const env = childPathEnvironment(process.env, joinPathParts([qtBinDirectory(), environmentPath()]));
	const result = spawnSync(executable, [], { windowsHide: true, env, input: JSON.stringify(fixture), encoding: "utf8", timeout: 20_000 });
	assert.equal(result.status, 0, result.stderr || String(result.error ?? ""));
	return JSON.parse(result.stdout);
}

test("native task acknowledgement does not consume an unrelated or intervening user turn", { skip }, async () => {
	const h = createTodoHarness();
	await h.command("todo-goal", "Inspect the parser");
	const task = { ...h.messages[0].message, role: "custom", timestamp: 1000 };
	for (const fixture of [
		{ pendingText: "/todo-goal Another task" },
		{ pendingText: "/todo-goal Inspect the parser", noRequestId: true },
		{ pendingText: "/todo-goal Inspect the parser", interveningMessage: true },
	]) {
		const result = native({ task, ...fixture });
		assert.equal(result.messages.length, fixture.interveningMessage ? 3 : 2);
		assert.equal(result.messages[0].role, "user");
		assert.equal(result.messages[0].text, fixture.pendingText);
	}
});

test("native argument-less task resolves its goal without duplicating the slash command", { skip }, async () => {
	const h = createTodoHarness();
	h.state.answer = "Inspect the parser";
	await h.command("todo-goal");
	const task = { ...h.messages[0].message, role: "custom", timestamp: 1000 };
	const result = native({ task, pendingText: "/todo-goal" });
	assert.equal(result.messages.length, 1);
	assert.equal(result.messages[0].text, "/todo-goal Inspect the parser");
	assert.equal(result.neutralGoal, "Inspect the parser");
});
