import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();
const skip = executable ? false : "PiDeckBackend executable not found";
const portable = (path) => path.replaceAll("\\", "/");

/** Pi's default layout encodes the absolute cwd into one directory name. */
function projectDirectoryToken(path) {
	const normalized = portable(path).replace(/\/+$/, "");
	const encoded = normalized.replace(/^([A-Za-z]):\//, "$1--").replace(/^\//, "").replaceAll("/", "-");
	return `--${encoded}--`;
}

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
	let projectPath;
	const backend = await startBackendSession(t, {
		prepare(fixture) {
			projectPath = join(fixture.root, "project");
			const otherProjectPath = join(fixture.root, "other-project");
			mkdirSync(projectPath);
			mkdirSync(otherProjectPath);
			writeFileSync(join(fixture.userData, "projects.json"), JSON.stringify([
				{ id: "headers", path: projectPath, environment: "windows" },
				{ id: "other", path: otherProjectPath, environment: "windows" },
			]));
			const sessionsRoot = options.layout
				? join(fixture.home, ".pi", "agent", "sessions")
				: fixture.sessions;
			mkdirSync(sessionsRoot, { recursive: true });
			let directory = sessionsRoot;
			if (options.outsideRoots) directory = join(fixture.root, "outside");
			else if (options.layout === "ordinary") directory = join(sessionsRoot, "imported");
			else if (options.layout === "encoded-ancestor") {
				directory = join(sessionsRoot, "imported", projectDirectoryToken(projectPath), "nested");
			} else if (options.layout === "partial-encoded") {
				directory = join(sessionsRoot, `prefix-${projectDirectoryToken(projectPath)}`);
			} else if (options.layout === "encoded" || options.layout === "other-encoded") {
				directory = join(sessionsRoot, projectDirectoryToken(
					options.layout === "encoded" ? projectPath : otherProjectPath,
				));
			}
			mkdirSync(directory, { recursive: true });
			const parentPath = join(sessionsRoot, "parent.jsonl");
			const childName = options.layout === "token-filename" ? `${projectDirectoryToken(projectPath)}.jsonl` : "child.jsonl";
			childPath = join(directory, childName);
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
				version: options.cacheVersion ?? 4,
				entries: { [portable(childPath)]: {
					version: { mtimeMs: Math.floor(version.mtimeMs), size: version.size },
					value: {
						...child, name: child.title, projectPath: options.cachedProjectPath ?? portable(projectPath),
						preview: "old preview", messageCount: 99,
					},
				} },
			}));
			return { env: { PIDECK_SESSIONS_DIR: sessionsRoot } };
		},
	});
	const reply = await backend.invoke("sessions:catalog-list", ["headers"]);
	assert.equal(reply.payload.ok, true, JSON.stringify(reply.payload));
	const raw = await backend.invoke("sessions:list", ["headers"]);
	assert.equal(raw.payload.ok, true, JSON.stringify(raw.payload));
	const stored = JSON.parse(readFileSync(join(backend.fixture.userData, "session-catalog.json"), "utf8"));
	return {
		...backend, records: reply.payload.result, projectPath: portable(projectPath),
		child: reply.payload.result.find((entry) => entry.id === "child-stable-id"),
		summary: raw.payload.result.find((entry) => entry.filePath === portable(childPath)),
		stored: stored.sessions.find((entry) => entry.id === "child-stable-id"),
	};
}

for (const [name, options] of [
	["nested headers", { cwd: "nested" }],
	["standard headers", { cwd: "standard" }],
	["flat files in the default sessions root", { layout: "flat" }],
	["ordinary directories in the default sessions root", { layout: "ordinary" }],
	["encoded project directories", { layout: "encoded" }],
	["version 5 filename-derived cwd summaries", { layout: "flat", cacheVersion: 5, cachedProjectPath: "hild.jsonl" }],
	["version 5 ordinary-directory cwd summaries", { layout: "ordinary", cacheVersion: 5, cachedProjectPath: "mported" }],
]) {
	test(`registered ${name} rebuild catalog ancestry and retain stable session identity`, { skip }, async (t) => {
		const fixture = await registeredHeaderSession(t, options);
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

for (const layout of ["encoded", "encoded-ancestor"]) {
	test(`${layout} project directories still discover sessions without a recognized cwd`, { skip }, async (t) => {
		const fixture = await registeredHeaderSession(t, { layout, unregistered: true });
		assert.equal(fixture.summary?.preview, "fresh preview");
		assert.ok(fixture.records.some((entry) => entry.filePath === fixture.summary.filePath));
	});
}

test("a standard cwd takes precedence over a different encoded project directory", { skip }, async (t) => {
	const fixture = await registeredHeaderSession(t, { layout: "other-encoded", cwd: "standard" });
	assert.equal(fixture.child?.preview, "fresh preview");
	assert.equal(fixture.summary?.projectPath, fixture.projectPath.toLowerCase());
});

for (const [directory, projectPath] of [
	["--C--work-app--", "C:/work/app"],
	["--home-dev-app--", "/home/dev/app"],
	["--mnt-c-work-app--", "/mnt/c/work/app"],
	["--C----", "C:/"],
	["----", "/"],
	["--C--", "/C"],
]) {
	test(`encoded ${directory} directories preserve their absolute cwd`, { skip }, async (t) => {
		const backend = await startBackendSession(t, {
			projects: [{ id: "encoded", path: projectPath }],
			prepare(fixture) {
				const sessionsRoot = join(fixture.home, ".pi", "agent", "sessions");
				const directoryPath = join(sessionsRoot, directory);
				mkdirSync(directoryPath, { recursive: true });
				writeFileSync(join(directoryPath, "child.jsonl"), `${JSON.stringify({ type: "session", id: "encoded" })}\n`);
				return { env: { PIDECK_SESSIONS_DIR: sessionsRoot } };
			},
		});
		const reply = await backend.invoke("sessions:list", ["encoded"]);
		assert.equal(reply.payload.ok, true, JSON.stringify(reply.payload));
		assert.equal(reply.payload.result.length, 1);
		assert.equal(portable(reply.payload.result[0].projectPath), projectPath);
	});
}

/** Similar directory tokens must not move a stable catalog identity between projects. */
async function rootDirectorySessions(t, sessions) {
	return startBackendSession(t, {
		projects: [
			{ id: "drive", path: "C:/" },
			{ id: "posix", path: "/C" },
			{ id: "other", path: "D:/" },
		],
		prepare(fixture) {
			const sessionsRoot = join(fixture.home, ".pi", "agent", "sessions");
			for (const { id, directory, cwd } of sessions) {
				const directoryPath = join(sessionsRoot, directory);
				mkdirSync(directoryPath, { recursive: true });
				writeFileSync(join(directoryPath, `${id}.jsonl`), `${JSON.stringify({ type: "session", id, cwd })}\n`);
			}
			return { env: { PIDECK_SESSIONS_DIR: sessionsRoot } };
		},
	});
}

for (const explicit of [false, true]) {
	test(`drive-root and ordinary POSIX directory tokens keep separate catalog identities with ${explicit ? "explicit" : "inferred"} cwd`, { skip }, async (t) => {
		const backend = await rootDirectorySessions(t, [
			{ id: "drive", directory: "--C----", ...(explicit ? { cwd: "C:/" } : {}) },
			{ id: "posix", directory: "--C--" },
		]);
		const stableIds = new Map();
		for (const projectId of ["drive", "posix", "drive", "posix"]) {
			const reply = await backend.invoke("sessions:catalog-list", [projectId]);
			assert.equal(reply.payload.ok, true, JSON.stringify(reply.payload));
			assert.equal(reply.payload.result.length, 1, `${projectId} must contain only its own session`);
			const record = reply.payload.result[0];
			assert.ok(portable(record.filePath).endsWith(`/${projectId}.jsonl`));
			assert.equal(record.projectId, projectId);
			if (stableIds.has(projectId)) assert.equal(record.id, stableIds.get(projectId));
			else stableIds.set(projectId, record.id);
		}
	});
}

test("an explicit cwd wins over a drive-root directory token", { skip }, async (t) => {
	const backend = await rootDirectorySessions(t, [{ id: "other", directory: "--C----", cwd: "D:/" }]);
	const matching = await backend.invoke("sessions:list", ["other"]);
	assert.equal(matching.payload.ok, true, JSON.stringify(matching.payload));
	assert.equal(matching.payload.result.length, 1);
	assert.equal(matching.payload.result[0].projectPath, "d:");
	const different = await backend.invoke("sessions:list", ["drive"]);
	assert.equal(different.payload.ok, true, JSON.stringify(different.payload));
	assert.deepEqual(different.payload.result, []);
});

for (const [name, options] of [
	["an unregistered file", { unregistered: true }],
	["a different explicit cwd", { cwd: "other" }],
	["another catalog project", { otherProject: true }],
	["another filesystem namespace", { foreignEnvironment: true }],
	["a path outside the scan roots", { outsideRoots: true }],
	["an unregistered default-root file", { layout: "flat", unregistered: true }],
	["an unregistered default-root subdirectory", { layout: "ordinary", unregistered: true }],
	["another default-root catalog project", { layout: "flat", otherProject: true }],
	["another default-root filesystem namespace", { layout: "ordinary", foreignEnvironment: true }],
	["another encoded project directory", { layout: "other-encoded" }],
	["a different explicit cwd in the default root", { layout: "flat", cwd: "other" }],
	["a project token in an unregistered filename", { layout: "token-filename", unregistered: true }],
	["a project token inside an unregistered directory name", { layout: "partial-encoded", unregistered: true }],
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
