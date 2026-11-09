import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { registerSubagentsIpc } = loadTsCommonJs("src/main/ipc/subagentsIpc.ts");
const { SubagentSettingsStore } = loadTsCommonJs("src/main/subagents/SubagentSettingsStore.ts");

/**
 * 子代理偏好 IPC 边界：渲染层数据一律不可信，非法作用域/项目 id 必须在 handler 内被拒绝，
 * 合法请求才落到 SubagentSettingsStore。
 */

function createHarness(projectPath) {
	const handlers = new Map();
	const router = { handle: (channel, handler) => handlers.set(channel, handler) };
	const store = new SubagentSettingsStore({
		getConfigDir: () => join(projectPath, "..", "agent"),
		getProjectPath: (projectId) => (projectId === "p1" ? projectPath : undefined),
	});
	registerSubagentsIpc(router, store);
	return {
		invoke: (channel, ...args) => handlers.get(channel)(...args),
		channels: [...handlers.keys()],
	};
}

test("subagents IPC registers both channels", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-subagents-ipc-"));
	try {
		const harness = createHarness(join(root, "project"));
		assert.deepEqual(harness.channels.sort(), [
			ipcChannels.subagentsGetSettings,
			ipcChannels.subagentsSaveSettings,
		].sort());
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("get-settings returns both scopes and tolerates a missing project id", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-subagents-ipc-"));
	try {
		const harness = createHarness(join(root, "project"));
		const withProject = await harness.invoke(ipcChannels.subagentsGetSettings, "p1");
		assert.deepEqual(JSON.parse(JSON.stringify(withProject)), {
			global: { useOwnModel: false, preferDelegation: false },
			project: { useOwnModel: false, preferDelegation: false },
		});
		// 空串按缺省处理：没有活动项目时渲染层会传 undefined
		const withoutProject = await harness.invoke(ipcChannels.subagentsGetSettings, "");
		assert.equal(withoutProject.project, null);
		await assert.rejects(() => harness.invoke(ipcChannels.subagentsGetSettings, 42), /projectId must be a string/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("save-settings rejects unknown scopes and project scope without a project", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-subagents-ipc-"));
	try {
		const harness = createHarness(join(root, "project"));
		const settings = { useOwnModel: false, preferDelegation: true };
		await assert.rejects(
			() => harness.invoke(ipcChannels.subagentsSaveSettings, "workspace", undefined, settings),
			/scope must be/,
		);
		await assert.rejects(
			() => harness.invoke(ipcChannels.subagentsSaveSettings, "project", undefined, settings),
			/projectId is required/,
		);
		// 非法偏好同样在边界拒绝，不会写出半份配置
		await assert.rejects(
			() => harness.invoke(ipcChannels.subagentsSaveSettings, "global", undefined, { useOwnModel: true }),
			/preferDelegation/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("save-settings writes the requested scope only", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-subagents-ipc-"));
	try {
		const projectPath = join(root, "project");
		const harness = createHarness(projectPath);
		await harness.invoke(ipcChannels.subagentsSaveSettings, "project", "p1", {
			useOwnModel: true,
			model: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "high" },
			preferDelegation: false,
		});
		const projectRaw = JSON.parse(await readFile(join(projectPath, ".pi", "settings.json"), "utf8"));
		assert.equal(projectRaw.subagents.defaultModel, "openai/gpt-5-mini");
		assert.equal(projectRaw.subagents.defaultProvider, "openai");
		assert.equal(projectRaw.subagents.defaultThinking, "high");
		assert.equal("preferDelegation" in projectRaw.subagents, false);

		// 全局文件没被这次写入创建
		await assert.rejects(() => readFile(join(root, "agent", "settings.json"), "utf8"), /ENOENT/);

		const snapshot = await harness.invoke(ipcChannels.subagentsGetSettings, "p1");
		assert.equal(snapshot.project.useOwnModel, true);
		assert.equal(snapshot.project.model.modelId, "gpt-5-mini");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
