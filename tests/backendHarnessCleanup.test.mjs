import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startCreateBackendHarness } from "./helpers/l4_createBackendHarness.mjs";
import { startWebWiringHarness } from "./helpers/l1a_webWiringHarness.mjs";

function tempDirs(prefix) {
	return new Set(
		readdirSync(tmpdir())
			.filter((name) => name.startsWith(prefix))
			.map((name) => join(tmpdir(), name)),
	);
}

function assertNoNewTemps(before, prefix) {
	const created = [...tempDirs(prefix)].filter((dir) => !before.has(dir));
	assert.deepEqual(created.filter((dir) => existsSync(dir)), []);
}

async function expectInitFailure(start, prefix) {
	const before = tempDirs(prefix);
	let harness;
	try {
		harness = await start({
			beforeCreate() {
				throw new Error("init failed");
			},
		});
		assert.fail("initialization failure must reject before returning a harness");
	} catch (error) {
		assert.match(error.message, /init failed/);
	} finally {
		if (harness) await harness.dispose();
	}
	assertNoNewTemps(before, prefix);
}

async function expectDisposeFailure(start, prefix) {
	const before = tempDirs(prefix);
	const harness = await start({
		afterCreate(backend) {
			backend.dispose = async () => {
				throw new Error("dispose failed");
			};
		},
	});
	try {
		await assert.rejects(harness.dispose(), /dispose failed/);
	} finally {
		assertNoNewTemps(before, prefix);
	}
}

async function expectNormalDispose(start, prefix) {
	const before = tempDirs(prefix);
	const harness = await start();
	await harness.dispose();
	assertNoNewTemps(before, prefix);
}

test("web wiring harness removes its temp directory when initialization fails", async () => {
	await expectInitFailure(startWebWiringHarness, "pideck-l1a-web-wiring-");
});

test("web wiring harness removes its temp directory when backend disposal rejects", async () => {
	await expectDisposeFailure(startWebWiringHarness, "pideck-l1a-web-wiring-");
});

test("web wiring harness removes its temp directory after normal disposal", async () => {
	await expectNormalDispose(startWebWiringHarness, "pideck-l1a-web-wiring-");
});

test("backend harness removes its temp directory when initialization fails", async () => {
	await expectInitFailure(startCreateBackendHarness, "pideck-l4-backend-");
});

test("backend harness removes its temp directory when backend disposal rejects", async () => {
	await expectDisposeFailure(startCreateBackendHarness, "pideck-l4-backend-");
});

test("backend harness removes its temp directory after normal disposal", async () => {
	await expectNormalDispose(startCreateBackendHarness, "pideck-l4-backend-");
});
