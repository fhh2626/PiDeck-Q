import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { getModelImageCapabilityNotice, isVisionBridgeConfigured, shouldPollVisionBridge, shouldShowVisionConvertingHint, VISION_BRIDGE_POLL_WINDOW_MS, buildModelKey, resolveModelImageSupport } = loadTsCommonJs(
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

const activeBridge = { enabled: true, provider: "openai", model: "gpt-4o-mini" };

/** 构造轮询判定输入；默认是一条刚发出、带图、视觉桥已就绪的实时消息。 */
function pollInput(overrides = {}) {
	const now = 1_700_000_000_000;
	return {
		hasImages: true,
		hasInlineBlocks: false,
		visionBridge: activeBridge,
		sentAt: now,
		now,
		...overrides,
	};
}

// 「要不要找事件」与「要不要显示转圈」是两件事：
// 桌面模型列表（pi --list-models 的 images 列）和 pi 自己的 ctx.model.input 不是同一份数据，
// 用桌面数据决定“不找”会在两边不一致时丢卡片。
test("shouldPollVisionBridge: 模型原生支持图片时仍轮询（取真实结果），但不显示转圈", () => {
	assert.equal(shouldPollVisionBridge(pollInput()), true);
	assert.equal(shouldShowVisionConvertingHint({ modelSupportsImages: true }), false);
});

test("shouldPollVisionBridge: 视觉桥未配置或不完整时不轮询", () => {
	assert.equal(shouldPollVisionBridge(pollInput({ visionBridge: null })), false);
	assert.equal(shouldPollVisionBridge(pollInput({ visionBridge: { ...activeBridge, enabled: false } })), false);
	assert.equal(shouldPollVisionBridge(pollInput({ visionBridge: { ...activeBridge, model: "" } })), false);
	assert.equal(shouldPollVisionBridge(pollInput({ visionBridge: { ...activeBridge, provider: "" } })), false);
});

test("shouldPollVisionBridge: 无视觉模型 + 桥就绪 + 刚发送时轮询", () => {
	assert.equal(shouldPollVisionBridge(pollInput()), true);
});

test("shouldPollVisionBridge: 模型图片能力未知时仍轮询并允许提示", () => {
	assert.equal(shouldPollVisionBridge(pollInput()), true);
	assert.equal(shouldShowVisionConvertingHint({ modelSupportsImages: undefined }), true);
	assert.equal(shouldShowVisionConvertingHint({ modelSupportsImages: false }), true);
});

test("shouldPollVisionBridge: 超过窗口的历史消息不再轮询", () => {
	const now = 1_700_000_000_000;
	assert.equal(
		shouldPollVisionBridge(pollInput({ sentAt: now - VISION_BRIDGE_POLL_WINDOW_MS - 1 })),
		false,
	);
	// 秒级时间戳（会话文件口径不一致）按历史消息处理
	assert.equal(shouldPollVisionBridge(pollInput({ sentAt: Math.floor(now / 1000) })), false);
	// 时间缺失
	assert.equal(shouldPollVisionBridge(pollInput({ sentAt: Number.NaN })), false);
});

test("shouldPollVisionBridge: 正文已有标记块 / 没有图片时不轮询", () => {
	assert.equal(shouldPollVisionBridge(pollInput({ hasInlineBlocks: true })), false);
	assert.equal(shouldPollVisionBridge(pollInput({ hasImages: false })), false);
});

test("isVisionBridgeConfigured: 三项齐全才算配置完成", () => {
	assert.equal(isVisionBridgeConfigured(activeBridge), true);
	assert.equal(isVisionBridgeConfigured(undefined), false);
	assert.equal(isVisionBridgeConfigured({ ...activeBridge, enabled: false }), false);
	assert.equal(isVisionBridgeConfigured({ ...activeBridge, model: "" }), false);
});

test("resolveModelImageSupport: 按 provider + modelId 命中，provider 缺失时仅按 modelId", () => {
	const models = [
		{ id: "claude-sonnet", provider: "anthropic", images: true },
		{ id: "deepseek-chat", provider: "deepseek", images: false },
		{ id: "deepseek-chat", provider: "openrouter", images: true },
	];
	assert.equal(resolveModelImageSupport(models, buildModelKey("anthropic", "claude-sonnet")), true);
	assert.equal(resolveModelImageSupport(models, buildModelKey("deepseek", "deepseek-chat")), false);
	// provider 相同 id 不同时不能串：命中带 image 支持的那个 provider
	assert.equal(resolveModelImageSupport(models, buildModelKey("openrouter", "deepseek-chat")), true);
	// provider 缺失时退化为按 id 匹配（与输入框提示规则一致）
	assert.equal(resolveModelImageSupport(models, buildModelKey(undefined, "claude-sonnet")), true);
});

test("resolveModelImageSupport: 列表查不到或键为空时返回 undefined（能力未知）", () => {
	const models = [{ id: "claude-sonnet", provider: "anthropic", images: true }];
	assert.equal(resolveModelImageSupport(models, buildModelKey("anthropic", "missing")), undefined);
	assert.equal(resolveModelImageSupport(undefined, buildModelKey("anthropic", "claude-sonnet")), undefined);
	assert.equal(resolveModelImageSupport(models, buildModelKey("anthropic", undefined)), undefined);
	assert.equal(resolveModelImageSupport(models, ""), undefined);
});
