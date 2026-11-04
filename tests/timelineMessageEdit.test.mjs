import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "jotai";
import {
	getEditPresentationAtom,
	sessionEditingRowKeysFamily,
} from "../src/renderer/src/atoms/timeline-presentation.ts";

test("步骤7编辑状态回归测试: 可序列化判别联合与草稿持久化", () => {
	const store = createStore();
	const sessionId = "sess-edit-test";
	const rowKey = "user-row-1";

	const editAtom = getEditPresentationAtom(sessionId, rowKey);

	// 初始为 idle
	assert.deepEqual(store.get(editAtom), { status: "idle" });

	// 开始编辑
	const target = {
		sessionId,
		agentId: "agent-1",
		runtimeGeneration: 1,
	};
	store.set(editAtom, {
		status: "editing",
		editId: "edit-123",
		messageId: "msg-user-1",
		text: "my draft prompt",
		runtimeTarget: target,
	});

	const editingKeysAtom = sessionEditingRowKeysFamily(sessionId);
	store.set(editingKeysAtom, new Set([rowKey]));

	// 校验数据格式可序列化
	const stored = store.get(editAtom);
	assert.equal(stored.status, "editing");
	if (stored.status === "editing") {
		assert.equal(stored.text, "my draft prompt");
		assert.equal(stored.runtimeTarget.agentId, "agent-1");
		assert.equal(stored.runtimeTarget.runtimeGeneration, 1);
	}

	assert.ok(store.get(editingKeysAtom).has(rowKey), "会话 editing rowKey 索引必须包含 rowKey");
});
