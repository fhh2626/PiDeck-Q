import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();
const skip = executable ? false : "PiDeckBackend executable not found";
const portable = (path) => path.replaceAll("\\", "/");

/** Exercise header parsing through the catalog and process-event public interfaces. */
async function sessionHeaders(t, parentFields, { cached = false } = {}) {
	let childPath;
	let parentPath;
	let projectPath;
	const backend = await startBackendSession(t, {
		prepare(fixture) {
			projectPath = join(fixture.root, "project");
			mkdirSync(projectPath);
			writeFileSync(join(fixture.userData, "projects.json"), JSON.stringify([
				{ id: "headers", path: projectPath, environment: "windows" },
			]));
			parentPath = join(fixture.sessions, "parent.jsonl");
			childPath = join(fixture.sessions, "child.jsonl");
			for (const [path, id, extra, name] of [
				[parentPath, "parent", {}, "Parent"],
				[childPath, "child", parentFields(parentPath), "subagent-worker"],
			]) {
				const entries = [
					{ type: "session", version: 3, id, cwd: projectPath, timestamp: "2026-01-01T00:00:00.000Z", ...extra },
					{ type: "session_info", id: `${id}-info`, name },
					{ type: "message", id: `${id}-user`, message: { role: "user", content: [{ type: "text", text: "hello" }] } },
				];
				writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			}
			if (cached) {
				const version = statSync(childPath);
				writeFileSync(join(fixture.userData, "session-summary-cache.json"), JSON.stringify({
					version: 4,
					entries: {
						[portable(childPath)]: {
							version: { mtimeMs: Math.floor(version.mtimeMs), size: version.size },
							value: {
								id: portable(childPath), filePath: portable(childPath), projectPath: portable(projectPath),
								name: "subagent-worker", preview: "cached", updatedAt: Math.floor(version.mtimeMs),
								messageCount: 1, source: "pi", isInternalSubagent: true,
								parentSessionPath: portable(parentPath),
							},
						},
					},
				}));
			}
		},
	});
	const response = await backend.invoke("sessions:catalog-list", ["headers"]);
	assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
	const child = response.payload.result.find((entry) => entry.filePath === portable(childPath));
	assert.ok(child, "The session must remain visible in the catalog");
	return { ...backend, child, parentPath: portable(parentPath), projectPath: portable(projectPath) };
}

test("standard Pi parentSession headers retain subagent ancestry and process metadata", { skip }, async (t) => {
	const fixture = await sessionHeaders(t, (parentSession) => ({ parentSession }));
	assert.equal(fixture.child.isInternalSubagent, true);
	assert.equal(fixture.child.parentSessionPath, fixture.parentPath);
	const events = await fixture.invoke("sessions:catalog-read-process-events", [fixture.child.id]);
	assert.equal(events.payload.ok, true, JSON.stringify(events.payload));
	const header = events.payload.result.find((event) => event.kind === "session");
	assert.equal(header.parentSession, fixture.parentPath);
	assert.equal(header.cwd, fixture.projectPath);
});

for (const key of ["branchedFrom", "parent_session"]) {
	test(`unrecognized ${key} fields do not change Pi session ancestry`, { skip }, async (t) => {
		const fixture = await sessionHeaders(t, (parent) => ({ [key]: parent }));
		assert.notEqual(fixture.child.isInternalSubagent, true);
		assert.equal(fixture.child.parentSessionPath, undefined);
	});
}

test("nested headers do not override the standard Pi session header contract", { skip }, async (t) => {
	const fixture = await sessionHeaders(t, (parentSession) => ({ header: { parentSession } }));
	assert.notEqual(fixture.child.isInternalSubagent, true);
	assert.equal(fixture.child.parentSessionPath, undefined);
	const events = await fixture.invoke("sessions:catalog-read-process-events", [fixture.child.id]);
	assert.equal(events.payload.ok, true, JSON.stringify(events.payload));
	const header = events.payload.result.find((event) => event.kind === "session");
	assert.equal(header.parentSession, undefined);
	assert.equal(header.cwd, fixture.projectPath);
});

test("cached ancestry from retired header formats is rebuilt from the session file", { skip }, async (t) => {
	const fixture = await sessionHeaders(t, () => ({}), { cached: true });
	assert.notEqual(fixture.child.isInternalSubagent, true);
	assert.equal(fixture.child.parentSessionPath, undefined);
});

/** Seed a real pre-upgrade catalog independently of the disposable summary cache. */
async function registeredHeaderSession(t, options = {}) {
	let childPath;
	const backend = await startBackendSession(t, {
		prepare(fixture) {
			const projectPath = join(fixture.root, "project");
			const otherProjectPath = join(fixture.root, "other-project");
			mkdirSync(projectPath);
			mkdirSync(otherProjectPath);
			writeFileSync(join(fixture.userData, "projects.json"), JSON.stringify([
				{ id: "headers", path: projectPath, environment: "windows" },
				{ id: "other", path: otherProjectPath, environment: "windows" },
			]));
			const directory = options.outsideRoots ? join(fixture.root, "outside") : fixture.sessions;
			mkdirSync(directory, { recursive: true });
			const parentPath = join(fixture.sessions, "parent.jsonl");
			childPath = join(directory, "child.jsonl");
			writeFileSync(parentPath, `${JSON.stringify({ type: "session", id: "parent", cwd: projectPath })}\n`);
			const header = {
				type: "session", id: "child", header: { cwd: projectPath, parentSession: parentPath },
				...(options.cwd === "standard" ? { cwd: projectPath } : {}),
				...(options.cwd === "other" ? { cwd: otherProjectPath } : {}),
			};
			writeFileSync(childPath, [header,
				{ type: "session_info", name: "subagent-worker" },
				{ type: "message", id: "u1", message: { role: "user", content: "fresh preview" } },
			].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
			const child = {
				id: "child-stable-id", projectId: options.otherProject ? "other" : "headers",
				title: "subagent-worker", source: "pi", environment: options.foreignEnvironment ? "wsl" : "native",
				filePath: portable(childPath), status: "active", createdAt: 1, updatedAt: 1,
				isInternalSubagent: true, parentSessionPath: portable(parentPath),
				scanMetadata: { projectPath: portable(projectPath), preview: "old preview", messageCount: 99 },
				...(options.foreignEnvironment ? { wslDistro: "OtherDistro", wslUser: "other-user" } : {}),
			};
			child.originKey = options.foreignEnvironment
				? `pi:wsl:OtherDistro:other-user:${portable(childPath)}`
				: `pi:native:${portable(childPath).toLowerCase()}`;
			writeFileSync(join(fixture.userData, "session-catalog.json"), JSON.stringify({
				version: 1, sessions: options.unregistered ? [] : [child],
			}));
			const version = statSync(childPath);
			writeFileSync(join(fixture.userData, "session-summary-cache.json"), JSON.stringify({
				version: 4,
				entries: { [portable(childPath)]: {
					version: { mtimeMs: Math.floor(version.mtimeMs), size: version.size },
					value: { ...child, name: child.title, projectPath: portable(projectPath), preview: "old preview", messageCount: 99 },
				} },
			}));
		},
	});
	const reply = await backend.invoke("sessions:catalog-list", ["headers"]);
	assert.equal(reply.payload.ok, true, JSON.stringify(reply.payload));
	const raw = await backend.invoke("sessions:list", ["headers"]);
	assert.equal(raw.payload.ok, true, JSON.stringify(raw.payload));
	const stored = JSON.parse(readFileSync(join(backend.fixture.userData, "session-catalog.json"), "utf8"));
	return {
		...backend, records: reply.payload.result,
		child: reply.payload.result.find((entry) => entry.id === "child-stable-id"),
		summary: raw.payload.result.find((entry) => entry.filePath === portable(childPath)),
		stored: stored.sessions.find((entry) => entry.id === "child-stable-id"),
	};
}

for (const cwd of ["nested", "standard"]) {
	test(`registered ${cwd} headers rebuild catalog ancestry and retain stable session identity`, { skip }, async (t) => {
		const fixture = await registeredHeaderSession(t, { cwd });
		assert.ok(fixture.child, "The existing stable session ID must survive the scan");
		for (const entry of [fixture.child, fixture.stored, fixture.summary]) {
			assert.ok(entry);
			assert.notEqual(entry.isInternalSubagent, true);
			assert.equal(entry.parentSessionPath, undefined);
			assert.equal(entry.parentSessionId, undefined);
			assert.equal(entry.existingCatalogSessionId, undefined, "Scan identity must remain internal");
			assert.equal(entry.existingCatalogOriginKey, undefined, "Scan namespace must remain internal");
		}
		assert.equal(fixture.child.preview, "fresh preview");
		assert.equal(fixture.stored.scanMetadata.preview, "fresh preview");
		assert.equal(fixture.summary.preview, "fresh preview");
	});
}

for (const [name, options] of [
	["an unregistered file", { unregistered: true }],
	["a different explicit cwd", { cwd: "other" }],
	["another catalog project", { otherProject: true }],
	["another filesystem namespace", { foreignEnvironment: true }],
	["a path outside the scan roots", { outsideRoots: true }],
]) {
	test(`catalog membership does not adopt ${name} through an ignored nested header`, { skip }, async (t) => {
		const fixture = await registeredHeaderSession(t, options);
		assert.equal(fixture.summary, undefined);
		if (options.unregistered) {
			assert.equal(fixture.stored, undefined);
			assert.equal(fixture.records.some((entry) => entry.title === "subagent-worker"), false);
		} else {
			assert.equal(fixture.stored.scanMetadata.preview, "old preview");
			assert.equal(fixture.stored.isInternalSubagent, true);
			assert.equal(fixture.stored.updatedAt, 1);
			assert.equal(fixture.stored.projectId, options.otherProject ? "other" : "headers");
			if (options.otherProject) assert.equal(fixture.child, undefined);
		}
	});
}
