import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakePi, encodeFrame, resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { waitFor, writeSessionFile } from "./helpers/native2RuntimeEvents.mjs";

if (resolveBackendExecutable()) {
	for (const ordering of ["replacement-first", "deletion-first"]) {
		test(`native deletion fences unknown replacement destination: ${ordering}`, { timeout: 45000 }, async (t) => {
			let fake;
			const project = mkdtempSync(join(tmpdir(), "pideck-native-fence-"));
			const session = await startBackendSession(t, {
				projects: [{ id: "reservation", path: project }],
				hostHandlers: { "shell.trashItem": () => ordering === "replacement-first" ? { result: { status: "trash-failed" } } : undefined },
				prepare: (fixture) => {
					const agentDir = join(fixture.home, ".pi", "agent");
					mkdirSync(agentDir, { recursive: true });
					writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [project]: true }));
					fake = createFakePi(fixture, { responses: { clone: { delayMs: 2000 } } });
					return { settings: { customPiPath: fake.shim }, env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath } };
				},
			});
			// Backend cleanup is registered first: Windows holds the live pi's cwd.
			// Yield during final handle release instead of blocking it with rmSync.
			t.after(() => rm(project, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }));
			const root = writeSessionFile(session.fixture.sessions, project, "fence-root");
			const other = writeSessionFile(session.fixture.sessions, project, "fence-other");
			const listed = await session.invoke("sessions:catalog-list", ["reservation"]);
			const record = (path) => listed.payload.result.find((item) => item.filePath.replaceAll("\\", "/") === path.replaceAll("\\", "/"));
			const rootRecord = record(root), otherRecord = record(other);
			assert.ok(rootRecord); assert.ok(otherRecord);
			const activation = await Promise.race([
				session.invoke("sessions:runtime-activate", [otherRecord.id]),
				new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`activation timed out; fake log: ${JSON.stringify(fake.readLog())}`)), 8000); timer.unref(); }),
			]);
			assert.equal(activation.payload.result.ok, true, JSON.stringify(activation.payload));
			const target = activation.payload.result.value;
			if (ordering === "replacement-first") {
				const replacement = session.invoke("sessions:runtime-clone", [target]);
				await waitFor(() => fake.commands().some((row) => row.command === "clone"), 10000, "clone RPC");
				const deletion = await session.invoke("sessions:catalog-delete", [rootRecord.id]);
				assert.equal(deletion.payload.ok, false, JSON.stringify(deletion.payload));
				assert.equal((await replacement).payload.result.ok, true);
			} else {
				const deletion = session.invoke("sessions:catalog-delete", [rootRecord.id]);
				const pending = await session.host.waitForRequest("shell.trashItem");
				try {
					const state = await session.invoke("sessions:runtime-state", [target]);
					assert.equal(state.payload.result.ok, true, JSON.stringify(state.payload));
					const replacement = await session.invoke("sessions:runtime-clone", [target]);
					assert.equal(replacement.payload.result.ok, false, JSON.stringify(replacement.payload));
					assert.equal(fake.commands().some((row) => row.command === "clone"), false);
				} finally { session.host.respond(pending.id, { status: "trash-failed" }); }
				assert.equal((await deletion).payload.result.status, "trash-failed");
				const replacement = await session.invoke("sessions:runtime-clone", [target]);
				assert.equal(replacement.payload.result.ok, true, JSON.stringify(replacement.payload));
			}
		});
	}
	test("deletion reservations cover alternate catalog identities for the same file", async (t) => {
		const ids = ["11111111-2222-4333-8444-555555555555", "99999999-8888-4777-8666-555555555555"];
		const session = await startBackendSession(t, {
			projects: [{ id: "reservation", path: process.cwd() }],
			hostHandlers: { "shell.trashItem": () => undefined },
			prepare: (fixture) => {
				const path = writeSessionFile(fixture.sessions, process.cwd(), "same-file");
				const sessions = ids.map((id, i) => ({ id, projectId: "reservation", filePath: path,
					environment: "native", source: "pi", originKey: `alias-${i}`, status: "active",
					title: `Alias ${i}`, createdAt: 1, updatedAt: 1 }));
				writeFileSync(join(fixture.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions }));
			},
		});
		const deletion = session.invoke("sessions:catalog-delete", [ids[0]]);
		const pending = await session.host.waitForRequest("shell.trashItem");
		try {
			const activation = await session.invoke("sessions:runtime-activate", [ids[1]]);
			assert.equal(activation.payload.result.ok, false);
			assert.match(activation.payload.result.error.debugDetails, /delet/i);
		} finally { session.host.respond(pending.id, { status: "trash-failed" }); }
		assert.equal((await deletion).payload.result.status, "trash-failed");
	});
	for (const hostError of [false, true]) {
		test(`deletion reserves its tree until ${hostError ? "bridge error" : "trash refusal"} and releases it before confirmation`, async (t) => {
			const session = await startBackendSession(t, {
				projects: [{ id: "reservation", path: process.cwd() }],
				hostHandlers: { "shell.trashItem": () => undefined },
				prepare: (fixture) => {
					const fake = createFakePi(fixture, {});
					return { settings: { customPiPath: fake.shim }, env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath } };
				},
			});
			const parent = writeSessionFile(session.fixture.sessions, process.cwd(), "parent");
			const companion = parent.slice(0, -6);
			mkdirSync(companion);
			const child = writeSessionFile(companion, process.cwd(), "child");
			const catalog = await session.invoke("sessions:catalog-list", ["reservation"]);
			const record = (path) => catalog.payload.result.find((item) => item.filePath.replaceAll("\\", "/") === path.replaceAll("\\", "/"));
			const rootRecord = record(parent), childRecord = record(child);
			assert.ok(rootRecord); assert.ok(childRecord);
			const deletion = session.invoke("sessions:catalog-delete", [rootRecord.id]);
			const pending = await session.host.waitForRequest("shell.trashItem");
			try {
				for (const id of [rootRecord.id, childRecord.id]) {
					const activation = await session.invoke("sessions:runtime-activate", [id]);
					assert.equal(activation.payload.result.ok, false, JSON.stringify(activation.payload));
					assert.match(activation.payload.result.error.debugDetails, /delet/i);
					const restart = await session.invoke("sessions:runtime-restart", [{ sessionId: id, agentId: "old-runtime", runtimeGeneration: 1 }]);
					assert.equal(restart.payload.result.ok, false);
					assert.match(restart.payload.result.error.debugDetails, /delet/i);
				}
				const duplicate = await session.invoke("sessions:catalog-delete", [rootRecord.id, { permanent: true }]);
				assert.equal(duplicate.payload.ok, false, JSON.stringify(duplicate.payload));
				const send = await session.invoke("sessions:send-prompt", [{ sessionId: childRecord.id, requestId: "during-delete", message: "must not start" }]);
				assert.equal(send.payload.result.accepted, false);
			} finally {
				session.host.socket.write(encodeFrame({ type: "response", id: pending.id, ok: !hostError,
					...(hostError ? { error: { message: "bridge rejected" } } : { result: { status: "trash-failed" } }) }));
			}
			const failed = await deletion;
			if (hostError) assert.equal(failed.payload.ok, false);
			else assert.equal(failed.payload.result.status, "trash-failed");
			session.host.handlers["shell.trashItem"] = () => ({ result: { status: "trash-failed" } });
			const retried = await session.invoke("sessions:catalog-delete", [rootRecord.id]);
			assert.equal(retried.payload.result.status, "trash-failed", JSON.stringify(retried.payload));
		});
	}
}
