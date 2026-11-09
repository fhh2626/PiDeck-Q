import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	SubagentSettingsStore,
	applySubagentSettings,
	readSubagentSettings,
	validateSubagentSettings,
} = loadTsCommonJs("src/main/subagents/SubagentSettingsStore.ts");

/**
 * 子代理偏好：读写 pi settings.json 的 subagents 块。
 * 关键约束：只 patch 四个已知键，其余配置原样保留；关闭开关时删除键恢复继承。
 */

function asJson(value) {
	return JSON.parse(JSON.stringify(value));
}

test("readSubagentSettings maps the subagents block", () => {
	assert.deepEqual(asJson(readSubagentSettings({})), { useOwnModel: false, preferDelegation: false });
	assert.deepEqual(
		asJson(readSubagentSettings({
			subagents: {
				defaultModel: "gpt-5-mini",
				defaultProvider: "openai",
				defaultThinking: "high",
				preferDelegation: true,
			},
		})),
		{
			useOwnModel: true,
			model: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "high" },
			preferDelegation: true,
		},
	);
	// 只有 provider 没有模型：扩展仍然继承主代理模型，不能算开启
	assert.deepEqual(asJson(readSubagentSettings({ subagents: { defaultProvider: "openai" } })), {
		useOwnModel: false,
		preferDelegation: false,
	});
	// PiDeck 写的是 provider/id 全限定形式，读回来必须还原成裸 modelId
	assert.deepEqual(
		asJson(readSubagentSettings({
			subagents: { defaultModel: "openai/gpt-5-mini", defaultProvider: "openai" },
		})).model,
		{ provider: "openai", modelId: "gpt-5-mini" },
	);
	// 模型 id 自带斜杠（OpenRouter）：只剥掉 provider 前缀这一层
	assert.deepEqual(
		asJson(readSubagentSettings({
			subagents: {
				defaultModel: "openrouter/anthropic/claude-sonnet-4",
				defaultProvider: "openrouter",
			},
		})).model,
		{ provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },
	);
	// 损坏结构按缺省处理，不抛异常
	assert.deepEqual(asJson(readSubagentSettings({ subagents: [] })), {
		useOwnModel: false,
		preferDelegation: false,
	});
});

test("applySubagentSettings only touches the managed keys", () => {
	const base = {
		defaultModel: "claude-sonnet-4",
		subagents: {
			agentOverrides: { readonly: { model: "x" } },
			disableBuiltins: true,
			defaultModel: "old-model",
			defaultProvider: "old-provider",
			defaultThinking: "low",
			preferDelegation: true,
		},
	};

	const enabled = applySubagentSettings(base, {
		useOwnModel: true,
		model: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "high" },
		preferDelegation: false,
	});
	assert.equal(enabled.defaultModel, "claude-sonnet-4", "top-level keys must survive");
	const block = enabled.subagents;
	assert.deepEqual(asJson(block.agentOverrides), { readonly: { model: "x" } });
	assert.equal(block.disableBuiltins, true);
	assert.equal(block.defaultModel, "openai/gpt-5-mini", "写盘用全限定 id，避免斜杠 id 解析到别的 provider");
	assert.equal(block.defaultProvider, "openai");
	assert.equal(block.defaultThinking, "high");
	assert.equal("preferDelegation" in block, false, "turning the switch off deletes the key");

	// 关闭独立模型：三个模型键一起删除，恢复继承主代理
	const disabled = applySubagentSettings(enabled, { useOwnModel: false, preferDelegation: false });
	const disabledBlock = disabled.subagents;
	assert.equal("defaultModel" in disabledBlock, false);
	assert.equal("defaultProvider" in disabledBlock, false);
	assert.equal("defaultThinking" in disabledBlock, false);
	assert.equal(disabledBlock.disableBuiltins, true, "other subagents keys must survive");

	// 手写的独立设置不能被「没碰过开关」的保存顺手清掉：
	// defaultProvider 只给裸 model id 指定 provider、defaultThinking 统一给子代理设档位，
	// 两者在扩展里都能脱离 defaultModel 生效。
	const handWritten = applySubagentSettings(
		{ subagents: { defaultProvider: "gpu-a", defaultThinking: "high", disableBuiltins: true } },
		{ useOwnModel: false, preferDelegation: true },
	);
	assert.equal(handWritten.subagents.defaultProvider, "gpu-a");
	assert.equal(handWritten.subagents.defaultThinking, "high");
	assert.equal(handWritten.subagents.disableBuiltins, true);
	assert.equal(handWritten.subagents.preferDelegation, true);

	// defaultModel 写成坏值（空串/数字）时扩展会抛错，弹框显示为关闭：保存要能清掉它
	const repaired = applySubagentSettings(
		{ subagents: { defaultModel: "", defaultProvider: "gpu-a" } },
		{ useOwnModel: false, preferDelegation: false },
	);
	assert.equal("subagents" in repaired, false, "坏掉的 defaultModel 连同块一起清掉");

	// 块变空时整块删除，避免留下 "subagents": {}
	const emptied = applySubagentSettings(
		{ subagents: { defaultModel: "m" } },
		{ useOwnModel: false, preferDelegation: false },
	);
	assert.equal("subagents" in emptied, false);
});

test("validateSubagentSettings rejects malformed input", () => {
	assert.throws(() => validateSubagentSettings(null), /must be an object/);
	assert.throws(() => validateSubagentSettings({ useOwnModel: "yes", preferDelegation: false }), /useOwnModel/);
	assert.throws(() => validateSubagentSettings({ useOwnModel: false, preferDelegation: 1 }), /preferDelegation/);
	// 开启独立模型却没有模型：拒绝，避免写出「开着但不生效」的配置
	assert.throws(() => validateSubagentSettings({ useOwnModel: true, preferDelegation: false }), /model is required/);
	assert.throws(
		() => validateSubagentSettings({ useOwnModel: true, preferDelegation: false, model: { modelId: "" } }),
		/model.modelId/,
	);
	assert.throws(
		() => validateSubagentSettings({
			useOwnModel: true,
			preferDelegation: false,
			model: { provider: "openai", modelId: "m", thinkingLevel: "ultra" },
		}),
		/thinkingLevel/,
	);
	assert.deepEqual(
		asJson(validateSubagentSettings({
			useOwnModel: true,
			preferDelegation: true,
			model: { provider: "openai", modelId: "m", thinkingLevel: "xhigh" },
		})),
		{
			useOwnModel: true,
			model: { provider: "openai", modelId: "m", thinkingLevel: "xhigh" },
			preferDelegation: true,
		},
	);
});

test("store round-trips global and project scopes without clobbering other settings", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-subagent-settings-"));
	try {
		const configDir = join(root, "agent");
		const projectPath = join(root, "project");
		await mkdir(configDir, { recursive: true });
		await mkdir(join(projectPath, ".pi"), { recursive: true });
		await writeFile(
			join(configDir, "settings.json"),
			JSON.stringify({ hideThinkingBlock: true, subagents: { disableBuiltins: true } }),
			"utf8",
		);

		const store = new SubagentSettingsStore({
			getConfigDir: () => configDir,
			getProjectPath: (projectId) => (projectId === "p1" ? projectPath : undefined),
		});

		// 初始：全局可读、项目文件不存在按空配置处理
		const initial = await store.read("p1");
		assert.deepEqual(asJson(initial.global), { useOwnModel: false, preferDelegation: false });
		assert.deepEqual(asJson(initial.project), { useOwnModel: false, preferDelegation: false });
		assert.equal((await store.read()).project, null, "no project id means no project scope");

		await store.save("global", undefined, {
			useOwnModel: true,
			model: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "high" },
			preferDelegation: true,
		});
		const globalRaw = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"));
		assert.equal(globalRaw.hideThinkingBlock, true, "unrelated top-level keys must survive");
		assert.equal(globalRaw.subagents.disableBuiltins, true, "unrelated subagents keys must survive");
		assert.equal(globalRaw.subagents.defaultModel, "openai/gpt-5-mini");
		assert.equal(globalRaw.subagents.preferDelegation, true);

		// 项目作用域写自己的文件，不碰全局配置
		await store.save("project", "p1", { useOwnModel: false, preferDelegation: true });
		const projectRaw = JSON.parse(await readFile(join(projectPath, ".pi", "settings.json"), "utf8"));
		assert.equal(projectRaw.subagents.preferDelegation, true);
		assert.equal("defaultModel" in projectRaw.subagents, false);
		const afterProject = await store.read("p1");
		assert.deepEqual(asJson(afterProject.global), {
			useOwnModel: true,
			model: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "high" },
			preferDelegation: true,
		});

		// 关闭开关后键被删除
		await store.save("global", undefined, { useOwnModel: false, preferDelegation: false });
		const cleared = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"));
		assert.equal("defaultModel" in cleared.subagents, false);
		assert.equal("preferDelegation" in cleared.subagents, false);
		assert.equal(cleared.subagents.disableBuiltins, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("project scope without a known project is rejected", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-subagent-settings-"));
	try {
		const store = new SubagentSettingsStore({
			getConfigDir: () => root,
			getProjectPath: () => undefined,
		});
		await assert.rejects(
			() => store.save("project", "missing", { useOwnModel: false, preferDelegation: true }),
			/project settings require a known project/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
