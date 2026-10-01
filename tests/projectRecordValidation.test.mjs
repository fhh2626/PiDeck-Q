import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseProjectCatalog, parseProjectRecord } = loadTsCommonJs("src/main/projects/projectRecordValidation.ts");

test("invalid entries and duplicate ids are dropped, valid ones survive", () => {
	const valid = { id: "p1", name: "One", path: "C:/one", lastOpenedAt: 1 };
	const result = parseProjectCatalog([null, 1, valid, { ...valid, name: "Dup" }]);
	assert.ok(result);
	assert.equal(result.projects.length, 1);
	assert.equal(result.projects[0].id, "p1");
	assert.equal(result.projects[0].name, "One", "重复 id 保留第一条");
	assert.equal(result.dropped, 3);
});

test("a non-array value is rejected wholesale", () => {
	assert.equal(parseProjectCatalog({}), null);
	assert.equal(parseProjectCatalog("[1,2]"), null);
	assert.equal(parseProjectCatalog(null), null);
});

test("a wrong optional field is dropped without losing the record", () => {
	const result = parseProjectCatalog([
		{ id: "p1", path: "C:/one", lastOpenedAt: 2, environment: "mars", pinned: "yes", sortOrder: Number.NaN, kind: "chattt" },
	]);
	assert.ok(result);
	assert.equal(result.dropped, 0);
	const project = result.projects[0];
	assert.equal(project.id, "p1");
	assert.equal("environment" in project, false, "非法 environment 必须丢弃而不是保留脏值");
	assert.equal("pinned" in project, false);
	assert.equal("sortOrder" in project, false);
	assert.equal("kind" in project, false);
});

test("a record without id or path is rejected", () => {
	assert.equal(parseProjectRecord({ path: "C:/one" }), null);
	assert.equal(parseProjectRecord({ id: "p1" }), null);
	assert.equal(parseProjectRecord("p1"), null);
	assert.equal(parseProjectRecord([]), null);
});

test("valid optional fields round-trip", () => {
	const project = parseProjectRecord({
		id: "p1",
		path: "C:/one",
		name: "One",
		lastOpenedAt: 5,
		pinned: true,
		sortOrder: 3,
		kind: "chat",
		worktreeEnabled: true,
		worktreeParentId: "p0",
		environment: "wsl",
	});
	assert.equal(JSON.stringify(project), JSON.stringify({
		id: "p1",
		path: "C:/one",
		name: "One",
		lastOpenedAt: 5,
		pinned: true,
		sortOrder: 3,
		kind: "chat",
		worktreeEnabled: true,
		worktreeParentId: "p0",
		environment: "wsl",
	}));
});

test("missing name falls back to the path so the sidebar always has a label", () => {
	const project = parseProjectRecord({ id: "p1", path: "C:/one" });
	assert.equal(project.name, "C:/one");
	assert.equal(project.lastOpenedAt, 0, "缺失的 lastOpenedAt 用 0 兜底而不是 NaN");
});
