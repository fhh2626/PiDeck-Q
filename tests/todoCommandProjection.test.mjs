import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { reconcileOptimisticUserMessages } = loadTsCommonJs("src/renderer/src/utils/optimisticUserReconciliation.ts");

test("a task acknowledgement reconciles its optimistic user by request identity", () => {
	const local = { id: "request", agentId: "agent", role: "user", text: "/todo-goal Inspect the parser", timestamp: 1,
		meta: { optimistic: true, optimisticPending: true, optimisticRequestId: "request" } };
	const canonical = { id: "task", agentId: "agent", role: "system", text: "/todo-goal Inspect the parser", timestamp: 2,
		meta: { type: "todoTask", optimisticRequestId: "request" } };
	assert.deepEqual(Array.from(reconcileOptimisticUserMessages([local], [canonical]).droppedIds), ["request"]);
});
