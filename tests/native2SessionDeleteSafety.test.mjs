import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { backendEnvFor, FakeHost, resolveBackendExecutable, rpc, spawnBackend, startBackendSession, stopBackendProcess, waitForRendererReady } from "./helpers/native2BackendHarness.mjs";
import { holdExclusiveFileLock } from "./helpers/native2FileLock.mjs";

const executable = resolveBackendExecutable();
const runId = "11111111-2222-4333-8444-555555555555";

/** Probe this fixture's volume because macOS also supports case-sensitive storage. */
function isCaseInsensitiveVolume(directory) {
	const name = "PiDeckCaseProbe";
	writeFileSync(join(directory, name), "probe");
	try { return existsSync(join(directory, name.toLowerCase())); }
	finally { unlinkSync(join(directory, name)); }
}

/** Minimal catalog fixture with a structured ownership identity, never prose-based ownership. */
function writeOwnedSession(directory, projectPath, name, identity = runId, extension = ".jsonl") {
	const path = join(directory, `${name}${extension}`);
	writeFileSync(path, [
		{ type: "session", version: 3, id: name, cwd: projectPath, timestamp: "2026-01-01T00:00:00.000Z" },
		{ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: name }] } },
		{ type: "message", id: "r1", message: { role: "toolResult", toolName: "subagent", details: { mode: "single", runId: identity } } },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return path;
}

async function fixture(t, trash = () => ({ result: { status: "trash-failed" } })) {
	let project;
	const session = await startBackendSession(t, {
		prepare: ({ root, userData }) => {
			project = join(root, "project");
			mkdirSync(project);
			writeFileSync(join(userData, "projects.json"), JSON.stringify([{ id: "safe-delete", name: "fixture", path: project, environment: "windows" }]));
		},
		hostHandlers: { "shell.trashItem": trash },
	});
	const file = writeOwnedSession(session.fixture.sessions, project, "protected");
	const list = await session.invoke("sessions:catalog-list", ["safe-delete"]);
	const record = list.payload.result.find((item) => item.filePath.replaceAll("\\", "/") === file.replaceAll("\\", "/"));
	assert.ok(record);
	return { ...session, file, id: record.id };
}

if (executable) {
	for (const linked of [false, true]) test(`a ${linked ? "linked" : "real"} directory at the primary JSONL path cannot claim companion data`, async (t) => {
		const f = await fixture(t);
		const outside = join(f.fixture.root, "outside-primary"); mkdirSync(outside);
		const saved = join(outside, "original.jsonl"); renameSync(f.file, saved);
		const original = readFileSync(saved, "utf8");
		if (linked) symlinkSync(outside, f.file, process.platform === "win32" ? "junction" : "dir");
		else mkdirSync(f.file);
		const sibling = join(f.fixture.sessions, "protected"); mkdirSync(sibling);
		const sentinel = join(sibling, "unrelated.txt"); writeFileSync(sentinel, "unrelated companion data");
		const result = await f.invoke("sessions:catalog-delete", [f.id, { permanent: true }]);
		assert.equal(readFileSync(sentinel, "utf8"), "unrelated companion data");
		assert.equal(readFileSync(saved, "utf8"), original);
		if (linked) { assert.equal(result.payload.result, true); assert.equal(existsSync(f.file), false); }
		else { assert.equal(result.payload.ok, false); assert.ok(existsSync(f.file)); }
	});
	for (const name of ["subagent-artifacts", ".pideck-trash", ".pideck-archive", ".pi", ".git", "--peer-project--", ...(process.platform === "win32" ? ["SUBAGENT-ARTIFACTS"] : [])]) {
		test(`a session named ${name} never owns the shared storage directory`, async (t) => {
			const f = await startBackendSession(t, { projects: [{ id: "safe-delete", path: process.cwd() }] });
			const file = writeOwnedSession(f.fixture.sessions, process.cwd(), name);
			const shared = join(f.fixture.sessions, name);
			mkdirSync(shared);
			const sentinel = join(shared, "peer-artifact.md"); writeFileSync(sentinel, "peer-owned data");
			const owned = name.toLowerCase() === "subagent-artifacts" ? join(shared, `${runId}_owned.md`) : null;
			if (owned) writeFileSync(owned, "owned artifact");
			const record = (await f.invoke("sessions:catalog-list", ["safe-delete"])).payload.result.find((row) => row.filePath.replaceAll("\\", "/") === file.replaceAll("\\", "/"));
			assert.ok(record);
			const result = await f.invoke("sessions:catalog-delete", [record.id, { permanent: true }]);
			assert.equal(result.payload.result, true, JSON.stringify(result.payload));
			assert.equal(existsSync(file), false);
			assert.equal(readFileSync(sentinel, "utf8"), "peer-owned data");
			if (owned) assert.equal(existsSync(owned), false);
		});
	}
	for (const name of ["subagent-artifacts", ".pideck-trash", ".pideck-archive", ".pi", ".git", "--peer-project--"]) {
		test(`shared ${name} directory entries cannot grant session artifact ownership`, async (t) => {
			const f = await startBackendSession(t, { projects: [{ id: "safe-delete", path: process.cwd() }] });
			const file = writeOwnedSession(f.fixture.sessions, process.cwd(), name);
			const foreignRun = "99999999-8888-4777-8666-555555555555";
			const sharedRun = join(f.fixture.sessions, name, foreignRun);
			mkdirSync(sharedRun, { recursive: true });
			const sentinel = join(sharedRun, "peer-data.txt");
			writeFileSync(sentinel, "peer-owned data");
			const artifacts = join(f.fixture.sessions, "subagent-artifacts");
			mkdirSync(artifacts, { recursive: true });
			const foreignArtifact = join(artifacts, `${foreignRun}_output.txt`);
			const ownedArtifact = join(artifacts, `${runId}_output.txt`);
			writeFileSync(foreignArtifact, "foreign output");
			writeFileSync(ownedArtifact, "owned output");
			const listed = await f.invoke("sessions:catalog-list", ["safe-delete"]);
			const record = listed.payload.result.find((row) => row.filePath.replaceAll("\\", "/") === file.replaceAll("\\", "/"));
			assert.ok(record);
			const result = await f.invoke("sessions:catalog-delete", [record.id, { permanent: true }]);
			assert.equal(result.payload.result, true, JSON.stringify(result.payload));
			assert.equal(existsSync(file), false);
			assert.equal(existsSync(ownedArtifact), false, "structured tool results still establish ownership");
			assert.equal(readFileSync(foreignArtifact, "utf8"), "foreign output");
			assert.equal(readFileSync(sentinel, "utf8"), "peer-owned data");
		});
	}
	for (const name of ["subagent-artifacts", ".pi", ".git"]) {
		test(`case variants cannot claim shared ${name} storage on an insensitive volume`, async (t) => {
			const f = await startBackendSession(t, { projects: [{ id: "safe-delete", path: process.cwd() }] });
			if (!isCaseInsensitiveVolume(f.fixture.sessions)) return t.skip("The fixture volume is case sensitive");
			const file = writeOwnedSession(f.fixture.sessions, process.cwd(), name.toUpperCase());
			const shared = join(f.fixture.sessions, name);
			mkdirSync(shared);
			const sentinel = join(shared, "peer-data.txt"); writeFileSync(sentinel, "peer data");
			const listed = await f.invoke("sessions:catalog-list", ["safe-delete"]);
			const record = listed.payload.result.find((row) => row.filePath.replaceAll("\\", "/") === file.replaceAll("\\", "/"));
			assert.ok(record);
			const result = await f.invoke("sessions:catalog-delete", [record.id, { permanent: true }]);
			assert.equal(readFileSync(sentinel, "utf8"), "peer data");
			assert.equal(result.payload.result, true, JSON.stringify(result.payload));
			assert.equal(existsSync(file), false);
		});
	}
	for (const name of ["", ".", ".."]) {
		test(`session deletion rejects an unsafe companion stem ${JSON.stringify(name)}`, async (t) => {
			let path, sentinel;
			const f = await startBackendSession(t, {
				projects: [{ id: "safe-delete", path: process.cwd() }],
				prepare: (fixture) => {
					path = writeOwnedSession(fixture.sessions, process.cwd(), name);
					sentinel = join(fixture.sessions, "untouched.txt"); writeFileSync(sentinel, "keep");
					writeFileSync(join(fixture.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions: [{ id: "unsafe", projectId: "safe-delete", title: "unsafe", environment: "native", status: "active", filePath: path }] }));
				},
			});
			const result = await f.invoke("sessions:catalog-delete", ["unsafe", { permanent: true }]);
			assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
			assert.ok(existsSync(path));
			assert.equal(readFileSync(sentinel, "utf8"), "keep");
		});
	}
	for (const container of ["outputs", "structured-output"]) {
		test(`a run identity named ${container} cannot delete the shared artifact container`, async (t) => {
			const f = await startBackendSession(t, { projects: [{ id: "safe-delete", path: process.cwd() }] });
			const file = writeOwnedSession(f.fixture.sessions, process.cwd(), "reserved-run", container);
			writeOwnedSession(f.fixture.sessions, process.cwd(), "peer-run");
			const directory = join(f.fixture.sessions, "subagent-artifacts", container);
			mkdirSync(directory, { recursive: true });
			const ownedArtifact = join(directory, `${container}_owned.txt`);
			const peerArtifact = join(directory, `${runId}_peer.txt`);
			writeFileSync(ownedArtifact, "owned output");
			writeFileSync(peerArtifact, "peer output");
			const listed = await f.invoke("sessions:catalog-list", ["safe-delete"]);
			const record = listed.payload.result.find((row) => row.filePath.replaceAll("\\", "/") === file.replaceAll("\\", "/"));
			assert.ok(record);
			const result = await f.invoke("sessions:catalog-delete", [record.id, { permanent: true }]);
			assert.equal(readFileSync(peerArtifact, "utf8"), "peer output");
			assert.equal(result.payload.result, true, JSON.stringify(result.payload));
			assert.equal(existsSync(file), false);
			assert.equal(existsSync(ownedArtifact), false);
		});
	}
	for (const permanent of [false, true]) {
		test(`catalog path outside session roots is rejected (${permanent ? "permanent" : "trash"})`, async (t) => {
			let external;
			let trashCalls = 0;
			const f = await startBackendSession(t, {
				projects: [{ id: "safe-delete", path: process.cwd() }],
				prepare: (fixture) => {
					external = join(fixture.root, "outside.jsonl");
					writeFileSync(external, "external data");
					writeFileSync(join(fixture.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions: [{ id: "outside", projectId: "safe-delete", title: "outside", environment: "native", status: "active", filePath: external }] }));
				},
				hostHandlers: { "shell.trashItem": () => { trashCalls++; return { result: { status: "trash-failed" } }; } },
			});
			const result = await f.invoke("sessions:catalog-delete", ["outside", { permanent }]);
			assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
			assert.equal(trashCalls, 0);
			assert.equal(readFileSync(external, "utf8"), "external data");
		});
	}
	test("cataloged importer-root sessions remain deletable with a custom scan root", async (t) => {
		let path, sentinel;
		const f = await startBackendSession(t, {
			projects: [{ id: "safe-delete", path: process.cwd() }],
			prepare: (fixture) => {
				const root = join(fixture.home, ".pi", "agent", "sessions");
				mkdirSync(root, { recursive: true });
				path = writeOwnedSession(root, process.cwd(), "imported");
				sentinel = join(fixture.sessions, "keep.txt"); writeFileSync(sentinel, "keep");
				writeFileSync(join(fixture.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions: [{ id: "imported", projectId: "safe-delete", title: "imported", environment: "native", status: "active", filePath: path }] }));
			},
		});
		const result = await f.invoke("sessions:catalog-delete", ["imported", { permanent: true }]);
		assert.equal(result.payload.result, true, JSON.stringify(result.payload));
		assert.equal(existsSync(path), false); assert.equal(readFileSync(sentinel, "utf8"), "keep");
	});
	test("previously scanned custom root remains authorized after settings change", async (t) => {
		let path, settings, sentinel;
		const f = await startBackendSession(t, {
			settings: { singleInstance: false },
			prepare: (fixture) => {
				const project = join(fixture.root, "project"), rootA = join(fixture.root, "root-a"), rootB = join(fixture.root, "root-b");
				mkdirSync(join(project, ".pi"), { recursive: true }); mkdirSync(rootA); mkdirSync(rootB);
				settings = join(project, ".pi", "settings.json");
				writeFileSync(settings, JSON.stringify({ sessionDir: rootA }));
				writeFileSync(join(fixture.userData, "projects.json"), JSON.stringify([{ id: "custom", path: project, name: "custom", environment: "windows" }]));
				path = writeOwnedSession(rootA, project, "old"); sentinel = join(rootB, "keep.txt"); writeFileSync(sentinel, "keep");
				fixture.newRoot = rootB;
			},
		});
		const list = await f.invoke("sessions:catalog-list", ["custom"]);
		const record = list.payload.result.find((item) => item.filePath.replaceAll("\\", "/") === path.replaceAll("\\", "/"));
		assert.ok(record);
		writeFileSync(settings, JSON.stringify({ sessionDir: f.fixture.newRoot }));
		// A fresh backend must recover provenance from disk, not process memory.
		const host = new FakeHost({ token: "root-history-test", handlers: {} });
		let backend;
		try {
			const hostPort = await host.start();
			backend = spawnBackend({ executable, hostPort, token: "root-history-test", env: backendEnvFor(f.fixture) });
			const ready = await waitForRendererReady(host, 15000, backend);
			const result = await rpc(ready.url, ready.token, "sessions:catalog-delete", [record.id, { permanent: true }]);
			assert.equal(result.payload.result, true, JSON.stringify(result.payload));
			assert.equal(existsSync(path), false); assert.equal(readFileSync(sentinel, "utf8"), "keep");
		} finally { await stopBackendProcess(backend, host); }
	});
	test("historical roots do not authorize another project's catalog record", async (t) => {
		let path;
		const f = await startBackendSession(t, {
			prepare: (fixture) => {
				const project = join(fixture.root, "project-a"), other = join(fixture.root, "project-b"), root = join(fixture.root, "custom");
				mkdirSync(join(project, ".pi"), { recursive: true }); mkdirSync(other); mkdirSync(root);
				writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ sessionDir: root }));
				writeFileSync(join(fixture.userData, "projects.json"), JSON.stringify([{ id: "a", path: project, name: "a", environment: "windows" }, { id: "b", path: other, name: "b", environment: "windows" }]));
				path = writeOwnedSession(root, project, "protected");
				writeFileSync(join(fixture.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions: [{ id: "forged", projectId: "b", title: "forged", environment: "native", status: "active", filePath: path }] }));
			},
		});
		await f.invoke("sessions:catalog-list", ["a"]);
		const result = await f.invoke("sessions:catalog-delete", ["forged", { permanent: true }]);
		assert.equal(result.payload.ok, false, JSON.stringify(result.payload)); assert.equal(existsSync(path), true);
	});
	test("deletion still authorizes a project's configured relative session directory", async (t) => {
		let path;
		const f = await startBackendSession(t, {
			prepare: (fixture) => {
				const project = join(fixture.root, "project");
				const sessions = join(project, "custom-sessions");
				mkdirSync(join(project, ".pi"), { recursive: true });
				mkdirSync(sessions);
				writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ sessionDir: "custom-sessions" }));
				writeFileSync(join(fixture.userData, "projects.json"), JSON.stringify([{ id: "custom", path: project, name: "custom", environment: "windows" }]));
				path = writeOwnedSession(sessions, project, "custom");
			},
		});
		const list = await f.invoke("sessions:catalog-list", ["custom"]);
		const record = list.payload.result.find((item) => item.filePath.replaceAll("\\", "/") === path.replaceAll("\\", "/"));
		assert.ok(record);
		const result = await f.invoke("sessions:catalog-delete", [record.id, { permanent: true }]);
		assert.equal(result.payload.result, true, JSON.stringify(result.payload));
		assert.equal(existsSync(path), false);
	});

	for (const [label, peerId, extension] of [
		["uppercase extension", runId, ".JSONL"],
		["longer identity prefix", `${runId}_child`, ".jsonl"],
		["normalized identity", `${runId}!child`, ".jsonl"],
	]) {
		test(`permanent deletion preserves peer artifacts with ${label}`, async (t) => {
			const f = await fixture(t);
			writeOwnedSession(f.fixture.sessions, process.cwd(), "peer", peerId, extension);
			const outputId = peerId.replaceAll("!", "_");
			const artifacts = join(f.fixture.sessions, "subagent-artifacts");
			for (const dir of [artifacts, join(artifacts, "outputs"), join(artifacts, "structured-output")]) {
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, `${outputId}_output.txt`), "peer data");
				mkdirSync(join(dir, outputId));
				writeFileSync(join(dir, outputId, "keep.txt"), "peer directory");
			}
			const result = await f.invoke("sessions:catalog-delete", [f.id, { permanent: true }]);
			assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
			for (const dir of [artifacts, join(artifacts, "outputs"), join(artifacts, "structured-output")]) {
				assert.equal(readFileSync(join(dir, `${outputId}_output.txt`), "utf8"), "peer data");
				assert.equal(readFileSync(join(dir, outputId, "keep.txt"), "utf8"), "peer directory");
			}
		});
	}
	for (const managementTarget of [true, false]) {
		test(`producer management result is accepted in ${managementTarget ? "target" : "peer"}`, async (t) => {
			const f = await fixture(t);
			const path = managementTarget ? f.file : join(f.fixture.sessions, "peer.jsonl");
			const details = { mode: "management", results: [] };
			const message = { type: "message", message: { role: "toolResult", toolName: "subagent", details } };
			if (managementTarget) writeFileSync(path, readFileSync(path, "utf8") + JSON.stringify(message) + "\n");
			else writeFileSync(path, JSON.stringify(message) + "\n");
			mkdirSync(join(f.fixture.sessions, "subagent-artifacts"));
			const result = await f.invoke("sessions:catalog-delete", [f.id, { permanent: true }]);
			assert.equal(result.payload.result, true, JSON.stringify(result.payload));
		});
	}
	for (const [kind, details] of [["missing", undefined], ["null", null], ["empty", {}]]) {
		for (const failureTarget of [true, false]) {
			test(`failed subagent result with ${kind} details in ${failureTarget ? "target" : "peer"} preserves shared artifacts`, async (t) => {
				const f = await fixture(t);
				const path = failureTarget ? f.file : join(f.fixture.sessions, "peer.jsonl");
				const failure = JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "subagent", isError: true, details } }) + "\n";
				writeFileSync(path, failureTarget ? readFileSync(path, "utf8") + failure : failure);
				const artifacts = join(f.fixture.sessions, "subagent-artifacts"); mkdirSync(artifacts);
				const shared = join(artifacts, `${runId}_output.txt`); writeFileSync(shared, "uncertain ownership");
				const result = await f.invoke("sessions:catalog-delete", [f.id, { permanent: true }]);
				assert.equal(result.payload.result, true, JSON.stringify(result.payload));
				assert.equal(existsSync(f.file), false);
				assert.equal(readFileSync(shared, "utf8"), "uncertain ownership");
				if (!failureTarget) assert.equal(readFileSync(path, "utf8"), failure);
			});
		}
	}
	test("failed peer subagent result with empty details only sends the requested session to native trash", async (t) => {
		const trashPaths = [];
		const f = await fixture(t, ({ path }) => {
			assert.equal(basename(path), basename(f.file));
			assert.equal(realpathSync(dirname(path)), realpathSync(dirname(f.file)));
			trashPaths.push(basename(path));
			renameSync(f.file, join(f.fixture.root, "trashed.jsonl"));
			return { result: null };
		});
		const original = readFileSync(f.file, "utf8");
		const peer = join(f.fixture.sessions, "peer.jsonl");
		const failure = JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "subagent", isError: true, details: {} } }) + "\n";
		writeFileSync(peer, failure);
		const artifacts = join(f.fixture.sessions, "subagent-artifacts", "outputs");
		mkdirSync(artifacts, { recursive: true });
		const shared = join(artifacts, `${runId}_output.txt`); writeFileSync(shared, "uncertain ownership");
		const result = await f.invoke("sessions:catalog-delete", [f.id]);
		assert.equal(result.payload.result, true, JSON.stringify(result.payload));
		assert.deepEqual(trashPaths, [basename(f.file)]);
		assert.equal(existsSync(f.file), false);
		assert.equal(readFileSync(join(f.fixture.root, "trashed.jsonl"), "utf8"), original);
		assert.equal(readFileSync(peer, "utf8"), failure);
		assert.equal(readFileSync(shared, "utf8"), "uncertain ownership");
	});
	test("oversized ownership file is rejected without deleting any data", async (t) => {
		const f = await fixture(t);
		const peer = join(f.fixture.sessions, "peer.jsonl");
		writeFileSync(peer, "{}"); truncateSync(peer, 64 * 1024 * 1024 + 1);
		const artifacts = join(f.fixture.sessions, "subagent-artifacts"); mkdirSync(artifacts);
		const shared = join(artifacts, `${runId}_output.txt`); writeFileSync(shared, "keep");
		const result = await f.invoke("sessions:catalog-delete", [f.id, { permanent: true }]);
		assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
		assert.ok(existsSync(f.file)); assert.equal(readFileSync(shared, "utf8"), "keep");
	});
	test("malformed peer records cannot authorize deleting shared artifacts", async (t) => {
		const f = await fixture(t);
		const peer = writeOwnedSession(f.fixture.sessions, process.cwd(), "peer");
		writeFileSync(peer, '{"type":"message","message":{"role":"toolResult"');
		const artifacts = join(f.fixture.sessions, "subagent-artifacts");
		mkdirSync(artifacts);
		const shared = join(artifacts, `${runId}_output.txt`);
		writeFileSync(shared, "shared data");
		const result = await f.invoke("sessions:catalog-delete", [f.id, { permanent: true }]);
		assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
		assert.equal(readFileSync(shared, "utf8"), "shared data");
		assert.ok(existsSync(f.file));
	});

	for (const [label, entry] of [
		["message", { type: "message", message: [] }],
		["results", { type: "message", message: { role: "toolResult", toolName: "subagent", details: { mode: "parallel", results: { runId } } } }],
		["child", { type: "message", message: { role: "toolResult", toolName: "subagent", details: { mode: "single", children: [runId] } } }],
		["identity", { type: "message", message: { role: "toolResult", toolName: "subagent", details: { mode: "single", runId: [runId] } } }],
		["workflow summary", { type: "message", message: { role: "toolResult", toolName: "subagent", details: { mode: "workflow", workflowChildren: [runId] } } }],
		["successful result with empty details", { type: "message", message: { role: "toolResult", toolName: "subagent", isError: false, details: {} } }],
		["failed result with array details", { type: "message", message: { role: "toolResult", toolName: "subagent", isError: true, details: [] } }],
		["failed result with nonempty details but no mode", { type: "message", message: { role: "toolResult", toolName: "subagent", isError: true, details: { runId } } }],
	]) {
		test(`malformed peer ${label} envelope cannot authorize shared artifact deletion`, async (t) => {
			const f = await fixture(t);
			writeFileSync(join(f.fixture.sessions, "peer.jsonl"), JSON.stringify(entry) + "\n");
			const artifacts = join(f.fixture.sessions, "subagent-artifacts");
			mkdirSync(artifacts);
			const shared = join(artifacts, `${runId}_output.txt`);
			writeFileSync(shared, "shared data");
			const result = await f.invoke("sessions:catalog-delete", [f.id, { permanent: true }]);
			assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
			assert.equal(readFileSync(shared, "utf8"), "shared data");
			assert.ok(existsSync(f.file));
		});
	}

	test("peer companion directories protect identities absent from peer JSONL", async (t) => {
		const f = await fixture(t);
		const peer = writeOwnedSession(f.fixture.sessions, process.cwd(), "peer", "unrelated");
		mkdirSync(join(peer.slice(0, -6), runId), { recursive: true });
		const artifacts = join(f.fixture.sessions, "subagent-artifacts");
		mkdirSync(artifacts);
		const shared = join(artifacts, `${runId}_output.txt`);
		writeFileSync(shared, "peer data");
		const result = await f.invoke("sessions:catalog-delete", [f.id, { permanent: true }]);
		assert.equal(result.payload.result, true, JSON.stringify(result.payload));
		assert.equal(readFileSync(shared, "utf8"), "peer data");
	});
	test("peer shared companion entries still veto ambiguous artifact deletion", async (t) => {
		const f = await fixture(t);
		const peer = writeOwnedSession(f.fixture.sessions, process.cwd(), ".pi", "unrelated");
		mkdirSync(join(peer.slice(0, -6), runId), { recursive: true });
		const artifacts = join(f.fixture.sessions, "subagent-artifacts"); mkdirSync(artifacts);
		const shared = join(artifacts, `${runId}_output.txt`); writeFileSync(shared, "possible peer data");
		const result = await f.invoke("sessions:catalog-delete", [f.id, { permanent: true }]);
		assert.equal(result.payload.result, true, JSON.stringify(result.payload));
		assert.equal(readFileSync(shared, "utf8"), "possible peer data");
	});

	test("native Windows and macOS peer identities preserve possible case aliases", { skip: !["win32", "darwin"].includes(process.platform) }, async (t) => {
		const f = await fixture(t);
		writeOwnedSession(f.fixture.sessions, process.cwd(), "protected", "abc");
		writeOwnedSession(f.fixture.sessions, process.cwd(), "peer", "ABC");
		const artifacts = join(f.fixture.sessions, "subagent-artifacts");
		mkdirSync(artifacts);
		const shared = join(artifacts, "abc_output.txt");
		writeFileSync(shared, "peer data");
		const result = await f.invoke("sessions:catalog-delete", [f.id, { permanent: true }]);
		assert.equal(result.payload.result, true, JSON.stringify(result.payload));
		assert.equal(readFileSync(shared, "utf8"), "peer data");
	});
	test("case-sensitive artifact storage requires exact positive ownership", async (t) => {
		const f = await fixture(t);
		if (isCaseInsensitiveVolume(f.fixture.sessions)) return t.skip("The fixture volume is case insensitive");
		writeOwnedSession(f.fixture.sessions, process.cwd(), "protected", "abc");
		const artifacts = join(f.fixture.sessions, "subagent-artifacts"); mkdirSync(artifacts);
		const owned = join(artifacts, "abc_output.txt"), other = join(artifacts, "ABC_output.txt");
		writeFileSync(owned, "owned data"); writeFileSync(other, "other data");
		const result = await f.invoke("sessions:catalog-delete", [f.id, { permanent: true }]);
		assert.equal(result.payload.result, true, JSON.stringify(result.payload));
		assert.equal(existsSync(owned), false);
		assert.equal(readFileSync(other, "utf8"), "other data");
	});

	for (const component of ["subagent-artifacts", "outputs", "structured-output"]) {
		test(`permanent session deletion refuses a linked ${component} ownership directory`, async (t) => {
			const f = await fixture(t);
			const outside = join(f.fixture.userData, `outside-${component}`);
			const output = join(outside, `${runId}_output`);
			mkdirSync(output, { recursive: true });
			const sentinel = join(output, "keep.txt");
			writeFileSync(sentinel, "external data");
			const link = component === "subagent-artifacts"
				? join(f.fixture.sessions, component)
				: join(f.fixture.sessions, "subagent-artifacts", component);
			if (component !== "subagent-artifacts") mkdirSync(join(f.fixture.sessions, "subagent-artifacts"), { recursive: true });
			symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
			const result = await f.invoke("sessions:catalog-delete", [f.id, { permanent: true }]);
			assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
			assert.equal(readFileSync(sentinel, "utf8"), "external data");
			assert.ok(existsSync(f.file));
			const catalog = await f.invoke("sessions:catalog-list", ["safe-delete", { scan: false }]);
			assert.ok(catalog.payload.result.some((item) => item.id === f.id));
		});
	}

	test("permanent session deletion unlinks nested companion junctions without touching referents", async (t) => {
		const f = await fixture(t);
		const outside = join(f.fixture.userData, "outside-companion");
		mkdirSync(outside);
		const sentinel = join(outside, "keep.txt");
		writeFileSync(sentinel, "external data");
		const companion = f.file.slice(0, -6);
		mkdirSync(companion);
		symlinkSync(outside, join(companion, "linked"), process.platform === "win32" ? "junction" : "dir");
		const result = await f.invoke("sessions:catalog-delete", [f.id, { permanent: true }]);
		assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
		assert.equal(readFileSync(sentinel, "utf8"), "external data");
		assert.equal(existsSync(companion), false);
	});

	test("an unreadable peer cannot authorize permanently deleting shared artifacts", { skip: process.platform !== "win32" }, async (t) => {
		const f = await fixture(t);
		const peer = writeOwnedSession(f.fixture.sessions, process.cwd(), "peer");
		const artifacts = join(f.fixture.sessions, "subagent-artifacts");
		mkdirSync(artifacts);
		const shared = join(artifacts, `${runId}_output.txt`);
		writeFileSync(shared, "shared data");
		const release = await holdExclusiveFileLock(t, peer);
		try {
			const result = await f.invoke("sessions:catalog-delete", [f.id, { permanent: true }]);
			assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
			assert.equal(readFileSync(shared, "utf8"), "shared data");
			assert.ok(existsSync(f.file));
			const catalog = await f.invoke("sessions:catalog-list", ["safe-delete", { scan: false }]);
			assert.ok(catalog.payload.result.some((item) => item.id === f.id));
		} finally { await release(); }
	});
}
