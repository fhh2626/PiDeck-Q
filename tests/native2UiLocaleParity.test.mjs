import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	createFakePi,
	resolveBackendExecutable,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();
const PROJECT_ID = "ui-locale";

/**
 * `PIDECK_UI_LANGUAGE` is read verbatim by the bundled extensions
 * (`resources/extensions/**` maps only `en*` to English). The backend must therefore
 * forward the *resolved* locale, never the raw settings value (`system` / `pseudo`).
 */
if (executable) {
	describe("native2 PIDECK_UI_LANGUAGE is the resolved locale", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-locale-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		const spawnLanguage = async (t, settings) => {
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings,
				prepare: (fixture) => {
					fake = createFakePi(fixture, {});
					return {
						settings: { customPiPath: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			const created = await session.invoke("sessions:create-anonymous", [{ projectId: PROJECT_ID }]);
			assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
			const activated = await session.invoke("sessions:runtime-activate", [created.payload.result.session.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const spawn = fake.readLog().find((entry) => entry.kind === "spawn");
			assert.ok(spawn, "pi must have been spawned");
			return spawn.env.PIDECK_UI_LANGUAGE;
		};

		test("the default system language becomes a BCP-47 tag", async (t) => {
			const value = await spawnLanguage(t, { language: "system" });
			assert.ok(value === "en-US" || value === "zh-CN", `unexpected PIDECK_UI_LANGUAGE: ${value}`);
		});

		test("a missing language setting resolves like system, not to an empty value", async (t) => {
			const value = await spawnLanguage(t, {});
			assert.ok(value === "en-US" || value === "zh-CN", `unexpected PIDECK_UI_LANGUAGE: ${value}`);
		});

		test("the pseudo locale stays English and explicit locales pass through", async (t) => {
			assert.equal(await spawnLanguage(t, { language: "pseudo" }), "en-US");
			assert.equal(await spawnLanguage(t, { language: "zh-CN" }), "zh-CN");
			assert.equal(await spawnLanguage(t, { language: "en-GB" }), "en-US");
		});
	});
}
