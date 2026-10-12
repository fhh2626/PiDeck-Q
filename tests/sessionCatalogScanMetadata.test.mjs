import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts");

function summary(filePath, patch = {}) {
	return {
		filePath,
		name: "Session",
		source: "pi",
		projectPath: "/repo",
		preview: "first message",
		messageCount: 5,
		updatedAt: 10,
		parentSessionPath: undefined,
		...patch,
	};
}

test("cached catalog records keep scan metadata across reload", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-catalog-meta-"));
	const file = join(root, "catalog.json");
	try {
		const first = new SessionCatalog(file, {}, undefined, () => "/repo");
		await first.load();
		const scanned = await first.mergeScanned("project", [summary(join(root, "session.jsonl"))]);
		assert.equal(scanned[0].projectPath, "/repo");
		assert.equal(scanned[0].messageCount, 5);
		const cached = first.getRecord(scanned[0].id);
		assert.equal(cached.projectPath, "/repo");
		assert.equal(cached.preview, "first message");
		assert.equal(cached.messageCount, 5);
		cached.model = { provider: "changed", modelId: "changed" };

		const reloaded = new SessionCatalog(file);
		await reloaded.load();
		const again = reloaded.getRecord(scanned[0].id);
		assert.equal(again.projectPath, "/repo");
		assert.equal(again.preview, "first message");
		assert.equal(again.messageCount, 5);
		assert.equal(again.model, undefined);

		await reloaded.mergeScanned("project", [summary(join(root, "session.jsonl"), {
			preview: "",
			messageCount: 0,
		})]);
		const cleared = reloaded.getRecord(scanned[0].id);
		assert.equal(cleared.preview, "");
		assert.equal(cleared.messageCount, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("legacy catalog entries load without scan metadata", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-catalog-legacy-"));
	const file = join(root, "catalog.json");
	try {
		const id = "legacy-id";
		await writeFile(file, JSON.stringify({
			version: 1,
			sessions: [{
				id,
				projectId: "project",
				title: "Legacy",
				source: "pi",
				environment: "native",
				filePath: join(root, "legacy.jsonl"),
				status: "active",
				createdAt: 1,
				updatedAt: 2,
			}],
		}));
		const catalog = new SessionCatalog(file, {}, undefined, (projectId) => projectId === "project" ? "/registered" : undefined);
		await catalog.load();
		const record = catalog.getRecord(id);
		assert.equal(record.id, id);
		assert.equal(record.projectPath, "/registered");
		assert.equal(record.preview, "");
		assert.equal(record.messageCount, 0);
		const raw = JSON.parse(await readFile(file, "utf8"));
		assert.equal(raw.sessions[0].id, id);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cached child sessions keep their parent id", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-catalog-parent-"));
	try {
		const catalog = new SessionCatalog(join(root, "catalog.json"));
		await catalog.load();
		const parentPath = join(root, "parent.jsonl");
		const childPath = join(root, "child.jsonl");
		const scanned = await catalog.mergeScanned("project", [
			summary(parentPath, { name: "Parent" }),
			summary(childPath, { name: "Child", parentSessionPath: parentPath, messageCount: 1 }),
		]);
		const child = scanned.find((record) => record.filePath === childPath);
		const cached = catalog.listProjectRecords("project").find((record) => record.id === child.id);
		assert.equal(cached.parentSessionId, scanned.find((record) => record.filePath === parentPath).id);
		assert.equal(catalog.getRecord(child.id).parentSessionId, cached.parentSessionId);
		assert.equal(cached.isInternalSubagent, undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("bulk catalog records retain parent links without connecting another project's sessions", async () => {
 const root = await mkdtemp(join(tmpdir(), "pideck-catalog-bulk-"));
 try {
  const catalog = new SessionCatalog(join(root, "catalog.json")); await catalog.load();
  const parentPath = join(root, "parent.jsonl");
  const first = await catalog.mergeScanned("first", [summary(parentPath), summary(join(root, "child.jsonl"), { parentSessionPath: parentPath })]);
  const second = await catalog.mergeScanned("second", [summary(join(root, "other.jsonl"), { parentSessionPath: parentPath })]);
  const anonymous = catalog.createAnonymous({ projectId: "first", title: "Anonymous", environment: "native" });
  const all = catalog.listRecords();
  assert.equal(all.length, 4);
  assert.equal(all.find(record => record.id === anonymous.id).noSession, true);
  const child = first.find(record => record.parentSessionPath);
  assert.equal(all.find(record => record.id === child.id).parentSessionId, first.find(record => record.filePath === parentPath).id);
  assert.equal(all.find(record => record.id === second[0].id).parentSessionId, undefined);
  assert.equal(catalog.getRecord(second[0].id).parentSessionId, undefined);
  all.find(record => record.id === child.id).preview = "mutated";
  assert.equal(catalog.getRecord(child.id).preview, "first message");
 } finally { await rm(root, { recursive: true, force: true }); }
});
