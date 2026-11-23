import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";

/**
 * native package smoke (read-only inspection).
 *
 * The host executable does not import QtSql; only the sidecar does. A stage that ran
 * windeployqt on the host alone starts the window and then fails to load the backend with
 * STATUS_DLL_NOT_FOUND. This test inspects the real validation stage (built with
 * `PIDECK_STAGE_DIR=build/native2-validation-unpacked`) and proves every Qt DLL the
 * backend imports beside it is present. Outside the required gate it skips when the
 * validation stage has not been built at all, so the normal test run does not require
 * packaging. Under `PIDECK_REQUIRE_BACKEND_TESTS=1` a missing stage must FAIL: a skipped
 * stage suite in the required run would read as "the packaged Qt runtime was verified".
 *
 * There is deliberately no debug-stage exemption any more: the stage now deploys the Qt
 * flavor the executable imports (`xmake.lua` uses `windeployqt --release` in both modes,
 * because the pideck-qt package links release import names even for `-m debug`), so a
 * debug stage is runnable and must pass the same assertions.
 */
// The build honours PIDECK_STAGE_DIR, so the gate reads the same directory: a validation
// worker can point it at the stage it just produced instead of the default path.
const STAGE = process.env.PIDECK_STAGE_DIR
	? resolve(process.env.PIDECK_STAGE_DIR)
	: join(process.cwd(), "build", "native2-validation-unpacked");
const REQUIRED = process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1";
const BUILD_HINT =
	"PIDECK_STAGE_DIR=build/native2-validation-unpacked xmake f -m release -y && xmake -r";

if (process.platform === "win32") {
	describe("native2 C++ sidecar stage", () => {
		test("ships every Qt runtime DLL the backend imports and no Node runtime", (t) => {
			const backend = join(STAGE, "PiDeckBackend.exe");
			if (!existsSync(backend)) {
				if (REQUIRED) {
					assert.fail(`PIDECK_REQUIRE_BACKEND_TESTS=1 but no C++ stage at ${STAGE}; build it with "${BUILD_HINT}"`);
				}
				t.skip(`validation stage not built (${BUILD_HINT})`);
				return;
			}
			const binary = readFileSync(backend);
			const imports = new Set(binary.toString("latin1").match(/Qt6[A-Za-z0-9]+\.dll/g) ?? []);
			assert.ok(imports.size > 0, "the backend must expose inspectable Qt imports");
			for (const dll of imports) {
				assert.ok(existsSync(join(STAGE, dll)), `missing sidecar dependency in stage: ${dll}`);
			}
			// The QSQLITE driver is staged explicitly; windeployqt never ships SQL drivers, and
			// without it the prompt/model/OpenCode catalog silently degrades to an empty result.
			assert.ok(
				existsSync(join(STAGE, "sqldrivers", "qsqlite.dll"))
					|| existsSync(join(STAGE, "sqldrivers", "qsqlited.dll")),
				"the QSQLITE driver must be part of the package",
			);
			assert.equal(existsSync(join(STAGE, "node.exe")), false, "a C++ package must not carry node.exe");
			assert.equal(existsSync(join(STAGE, "node", "node.exe")), false, "a C++ package must not carry node.exe");
		});
	});
}
