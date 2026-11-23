import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { isRemovedModel, resolveSelectedModel, clearRemovedModelReferences, clearPiModelDefaults } = loadTsCommonJs(
	"src/renderer/src/utils/modelSelection.ts",
);
const removed = [{ provider: "custom", modelId: "shared/name" }];

test("model removal matches the complete provider and model identity", () => {
	assert.equal(isRemovedModel({ provider: "custom", modelId: "shared/name" }, removed), true);
	assert.equal(isRemovedModel({ provider: "other", modelId: "shared/name" }, removed), false);
	assert.equal(isRemovedModel(undefined, removed), false);
});

test("an explicitly cleared selection masks a still running agent's old model", () => {
	const live = { provider: "custom", modelId: "shared/name", modelName: "Old model" };
	assert.equal(resolveSelectedModel({ provider: "", modelId: "" }, live).modelId, "");
	assert.equal(resolveSelectedModel(undefined, live).modelId, "shared/name");
});

test("model removal clears matching selections and pending changes without changing unrelated sessions", () => {
	const kept = { id: "kept", model: { provider: "other", modelId: "shared/name" } };
	const records = [{ id: "removed", model: removed[0] }, kept];
	const pending = {
		removed: { from: removed[0], to: { provider: "other", modelId: "next" } },
		deletedTarget: { from: kept.model, to: removed[0] },
		kept: { from: kept.model, to: kept.model },
	};
	const result = clearRemovedModelReferences(records, pending, removed);
	assert.equal(result.records[0].model.provider, "");
	assert.equal(result.records[0].model.modelId, "");
	assert.equal(result.records[1], kept);
	assert.deepEqual({ ...result.pending.removed.from }, { provider: "", modelId: "" });
	assert.equal(result.pending.removed.to, pending.removed.to);
	assert.equal(result.pending.deletedTarget, undefined);
	assert.equal(result.pending.kept, pending.kept);
});

test("legacy qualified defaults are cleared without requiring a separate provider field", () => {
	const result = clearPiModelDefaults({ defaultModel: "custom/shared/name", theme: "dark" }, removed);
	assert.equal(result.defaultProvider, "");
	assert.equal(result.defaultModel, "");
	assert.equal(result.theme, "dark");
});
