import { spawnSync } from "node:child_process";

// Node only parses test-runner options before the positional test file patterns.
const result = spawnSync(process.execPath, [
	"--import", "./tests/helpers/testEnvironment.mjs",
	"--test", "--test-concurrency=4",
	...process.argv.slice(2),
	"tests/*.test.mjs", "resources/extensions/pideck-q-change-pi-prompt/tests/*.test.mjs",
], { stdio: "inherit", windowsHide: true });

if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
