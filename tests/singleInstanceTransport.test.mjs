import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
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
		// acquireVersionSingleInstance does not resolve until the focus payload has
		// been handed to the primary, so secondary shutdown cannot race delivery.
		assert.equal(received.length, 1);
		assert.deepEqual(Array.from(received[0].argv), ["secondary", "pideck://session/abc"]);
		assert.equal(typeof received[0].at, "number");
	} finally {
		secondary?.dispose();
		primary?.dispose();
		rmSync(userDataDir, { recursive: true, force: true });
	}
});

test("focus endpoint rejects payloads larger than 64 KiB", async () => {
	const userDataDir = mkdtempSync(join(tmpdir(), "pideck-single-limit-"));
	let primary;
	try {
		const received = [];
		primary = await acquireVersionSingleInstance({
			enabled: true,
			version: "1.2.3",
			userDataDir,
			argv: ["node"],
			onFocusRequest: (payload) => received.push(payload),
		});
		const lockPath = join(userDataDir, "instance-locks", "1.2.3.lock");
		const endpoint = JSON.parse(readFileSync(lockPath, "utf8")).endpoint;
		const socket = createConnection(endpoint);
		await new Promise((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		const closed = new Promise((resolve) => socket.once("close", resolve));
		socket.end("x".repeat(64 * 1024 + 1));
		await Promise.race([
			closed,
			new Promise((_, reject) => setTimeout(() => reject(new Error("oversized focus payload was not rejected")), 2_000)),
		]);
		assert.deepEqual(received, []);
	} finally {
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
