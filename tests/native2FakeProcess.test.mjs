import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { writeNodeShim } from "./helpers/native2FakeProcess.mjs";

const { PiLocator } = loadTsCommonJs(resolve("src/main/pi/PiLocator.ts"));

test("the native CLI fixture forwards exact argv through the host platform launcher", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pideck-native-cli-shim-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const directory = join(root, "R&D's shims (beta)");
	mkdirSync(directory);
	const script = join(directory, "argv 'child'.mjs");
	writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
	const shim = writeNodeShim(directory, "pi", script);
	const marker = join(root, "unexpected-command.txt");
	const args = ["install", `npm:probe&echo>${marker}`, "with space", "Unicode-雪", ""];
	const invocation = new PiLocator().createInvocation(shim, args);
	const result = spawnSync(invocation.command, invocation.args, {
		encoding: "utf8",
		shell: invocation.shell,
		windowsVerbatimArguments: invocation.windowsVerbatimArguments,
	});
	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), args);
	assert.equal(existsSync(marker), false);
});
