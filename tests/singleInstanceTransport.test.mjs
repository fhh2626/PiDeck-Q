import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { acquireVersionSingleInstance } = loadTsCommonJs("src/main/singleInstance.ts", {
	stubs: {
		"./logging/sharedLogger": { getAppLogger: () => undefined },
	},
});

test("secondary instance sends focus payload through the version endpoint", async () => {
	const userDataDir = mkdtempSync(join(tmpdir(), "pideck-single-instance-"));
	const received = [];
	let primary;
	let secondary;
	try {
		primary = await acquireVersionSingleInstance({
			enabled: true,
			version: "1.2.3",
			userDataDir,
			argv: ["node", "primary"],
			onFocusRequest: (payload) => received.push(payload),
		});
		assert.equal(primary.isPrimary, true);

		secondary = await acquireVersionSingleInstance({
			enabled: true,
			version: "1.2.3",
			userDataDir,
			argv: ["node", "secondary", "pideck://session/abc"],
			onFocusRequest: () => {
				throw new Error("secondary must not become primary");
			},
		});
		assert.equal(secondary.isPrimary, false);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(received.length, 1);
		assert.deepEqual(Array.from(received[0].argv), ["secondary", "pideck://session/abc"]);
		assert.equal(typeof received[0].at, "number");
	} finally {
		secondary?.dispose();
		primary?.dispose();
		rmSync(userDataDir, { recursive: true, force: true });
	}
});

test("different versions can own separate focus endpoints", async () => {
	const userDataDir = mkdtempSync(join(tmpdir(), "pideck-single-version-"));
	const instances = [];
	try {
		for (const version of ["1.0.0", "2.0.0"]) {
			const instance = await acquireVersionSingleInstance({
				enabled: true,
				version,
				userDataDir,
				argv: ["node"],
				onFocusRequest: () => undefined,
			});
			assert.equal(instance.isPrimary, true);
			instances.push(instance);
		}
	} finally {
		for (const instance of instances) instance.dispose();
		rmSync(userDataDir, { recursive: true, force: true });
	}
});
