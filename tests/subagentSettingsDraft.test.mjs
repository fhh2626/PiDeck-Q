import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { dirtySubagentScopes, emptySubagentSettingsDraft, sameSubagentSettings } = loadTsCommonJs(
	"src/renderer/src/utils/subagentSettingsDraft.ts",
);

/**
 * 子代理偏好草稿比较：决定「保存」是否可用、以及保存时写哪几个作用域。
 * 关键点：关闭独立模型后残留的模型选择不算改动，否则关掉开关会一直显示未保存。
 */

/** vm realm 里 new 出来的数组原型不同，比较前先抄进本 realm。 */
const scopes = (...args) => [...dirtySubagentScopes(...args)];

const off = emptySubagentSettingsDraft();
const withModel = {
	useOwnModel: true,
	model: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "high" },
	preferDelegation: false,
};

test("sameSubagentSettings ignores the model when own-model is off", () => {
	assert.equal(sameSubagentSettings(off, { ...off }), true);
	// 关掉开关后草稿里还留着模型：保存会删除这些键，不算改动
	assert.equal(sameSubagentSettings({ ...off, model: withModel.model }, off), true);
	assert.equal(sameSubagentSettings(withModel, { ...withModel }), true);
	// 开关打开后模型参与比较
	assert.equal(sameSubagentSettings(withModel, { ...withModel, model: undefined }), false);
	assert.equal(
		sameSubagentSettings(withModel, { ...withModel, model: { ...withModel.model, thinkingLevel: "max" } }),
		false,
	);
	assert.equal(sameSubagentSettings(withModel, { ...withModel, preferDelegation: true }), false);
});

test("dirtySubagentScopes reports only scopes that changed", () => {
	const saved = { global: off, project: off };
	assert.deepEqual(
		scopes({ drafts: { global: off, project: off }, saved, projectAvailable: true }),
		[],
	);
	assert.deepEqual(
		scopes({
			drafts: { global: { ...off, preferDelegation: true }, project: off },
			saved,
			projectAvailable: true,
		}),
		["global"],
	);
	// 两个作用域都改过：保存时一起写盘，不静默丢弃另一个
	assert.deepEqual(
		scopes({
			drafts: { global: { ...off, preferDelegation: true }, project: withModel },
			saved,
			projectAvailable: true,
		}),
		["global", "project"],
	);
});

test("dirtySubagentScopes skips the project scope when no project is active", () => {
	assert.deepEqual(
		scopes({
			drafts: { global: off, project: withModel },
			saved: { global: off, project: null },
			projectAvailable: false,
		}),
		[],
		"没有活动项目时项目草稿不参与保存",
	);
});
