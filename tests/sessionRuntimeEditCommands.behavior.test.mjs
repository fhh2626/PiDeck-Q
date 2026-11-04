import test from "node:test";
import assert from "node:assert/strict";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

test("步骤5行为测试: SessionRuntimeInjector submitEditMessage 正确传递 false 与 reject，不吞错误", async () => {
	await withHookHost(async ({ React, load, mount, act }) => {
		const cmdMod = load("src/renderer/src/components/session/timeline/timelineEditCommandsContext.tsx");
		const { TimelineEditCommandsProvider } = cmdMod;

		const presMod = load("src/renderer/src/components/session/timeline/timelinePresentationContext.tsx");
		const { TimelinePresentationProvider } = presMod;

		const mod = load("src/renderer/src/hooks/useTimelineMessageEdit.ts", {
			stubs: {
				"../components/session/timeline/timelineEditCommandsContext": cmdMod,
				"../components/session/timeline/timelinePresentationContext": presMod,
			},
		});
		const { useTimelineMessageEdit } = mod;

		const atomMod = load("src/renderer/src/atoms/timeline-presentation.ts");
		const { getEditPresentationAtom, sessionEditingRowKeysFamily } = atomMod;

		let hookResult;
		let mockReturn = false;
		let callCount = 0;
		let lastPassedTarget = null;

		const mockSubmit = async (expectedTarget, messageId, newText) => {
			callCount++;
			lastPassedTarget = expectedTarget;
			if (mockReturn === "reject") {
				throw new Error("RPC_NETWORK_ERROR");
			}
			return mockReturn;
		};

		const editCommands = {
			currentRuntimeTarget: {
				sessionId: "sess-1",
				agentId: "agent-1",
				runtimeGeneration: 1,
			},
			submitEditMessage: mockSubmit,
		};

		const probe = await mount(
			() => {
				hookResult = useTimelineMessageEdit({
					messageId: "msg-target-1",
					initialText: "Initial user text",
				});
				return hookResult;
			},
			{},
			(child) =>
				React.createElement(
					TimelinePresentationProvider,
					{ value: { sessionId: "sess-1", rowKey: "message:msg-target-1" } },
					React.createElement(TimelineEditCommandsProvider, { value: editCommands }, child),
				),
		);

		// 1. 开始编辑
		act(() => {
			probe.result().beginEdit();
		});
		assert.equal(probe.result().isEditing, true, "开始编辑后 isEditing 必须为 true");

		// 2. 修改文本
		act(() => {
			probe.result().updateText("Modified user draft text");
		});
		assert.equal(probe.result().text, "Modified user draft text");

		// 3. 模拟提交失败（返回 false）
		mockReturn = false;
		let saveSuccess = false;
		await act(async () => {
			saveSuccess = await probe.result().saveEdit();
		});

		assert.equal(saveSuccess, false, "保存失败时 saveEdit 必须返回 false");
		assert.equal(probe.result().isEditing, true, "保存失败后状态必须保持在 editing，不能清空");
		assert.equal(
			probe.result().text,
			"Modified user draft text",
			"保存失败后必须完整保留用户的修改草稿文本！",
		);

		// 4. 模拟提交异常抛出（reject）
		mockReturn = "reject";
		await act(async () => {
			saveSuccess = await probe.result().saveEdit();
		});

		assert.equal(saveSuccess, false, "抛错时 saveEdit 必须返回 false 而非抛出到外部");
		assert.equal(probe.result().isEditing, true, "抛错后仍必须留在 editing");
		assert.equal(probe.result().text, "Modified user draft text", "抛错后草稿依然保留");

		// 5. 校验捕获的 runtimeTarget 锁死（修改 currentRuntimeTarget 后提交仍传旧 target）
		editCommands.currentRuntimeTarget = {
			sessionId: "sess-1",
			agentId: "agent-1",
			runtimeGeneration: 2, // 模拟会话代次推进
		};

		mockReturn = true;
		await act(async () => {
			saveSuccess = await probe.result().saveEdit();
		});

		assert.equal(lastPassedTarget?.runtimeGeneration, 1, "提交时必须传入开始编辑时锁定的旧 runtimeTarget！");
		assert.equal(saveSuccess, true, "成功后 saveEdit 返回 true");
		assert.equal(probe.result().isEditing, false, "成功后编辑状态转为 idle");
	});
});
