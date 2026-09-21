import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { getModelImageCapabilityNotice } = loadTsCommonJs(
	"src/renderer/src/utils/modelImageCapability.ts",
);

const toPlain = (val) => JSON.parse(JSON.stringify(val));

test("getModelImageCapabilityNotice: returns null when model natively supports images", () => {
	const model = { id: "gpt-4o", provider: "openai", images: true };
	assert.equal(getModelImageCapabilityNotice(model, undefined), null);
});

test("getModelImageCapabilityNotice: returns vision-bridge-active when model lacks vision but bridge is active", () => {
	const model = { id: "deepseek-chat", provider: "deepseek", images: false };
	const bridge = { enabled: true, provider: "openai", model: "gpt-4o-mini" };
	const notice = getModelImageCapabilityNotice(model, bridge);
	assert.deepEqual(toPlain(notice), { kind: "vision-bridge-active" });
});

test("getModelImageCapabilityNotice: returns unsupported-suggest-vision when model lacks vision and no bridge", () => {
	const model = { id: "deepseek-chat", provider: "deepseek", images: false };
	assert.deepEqual(toPlain(getModelImageCapabilityNotice(model, undefined)), {
		kind: "unsupported-suggest-vision",
	});

	const disabledBridge = { enabled: false, provider: "openai", model: "gpt-4o-mini" };
	assert.deepEqual(toPlain(getModelImageCapabilityNotice(model, disabledBridge)), {
		kind: "unsupported-suggest-vision",
	});
});

test("getModelImageCapabilityNotice: returns unknown-capability when model.images is undefined", () => {
	const model = { id: "custom-model", provider: "custom" };
	assert.deepEqual(toPlain(getModelImageCapabilityNotice(model, undefined)), {
		kind: "unknown-capability",
	});
});
