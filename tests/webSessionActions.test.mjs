/**
 * Web 关闭会话的数据契约：stopRuntime 必须按 SessionCommandResult<SessionRuntimeTarget>
 * 解析 —— value 直接是 target（SessionRuntimeCoordinator.stopRuntime 返回
 * { ok:true, value: target }），不是 callRuntimeCommand 期待的 SessionTargetedValue 嵌套。
 *
 * 若误用 value.value，成功关闭会解析成 undefined，强类型 API 契约失效。
 *
 * 注意：loadTsCommonJs 把被测模块跑在独立 VM realm，那里抛出的 Error 不满足宿主
 * `instanceof Error`，所以断言统一走「捕获后比对 message」而不是 validator 形式。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const target = {
	sessionId: "session-1",
	agentId: "agent-1",
	runtimeGeneration: 3,
};

let fetchImpl;
const { stopRuntime, deleteSession } = loadTsCommonJs("src/renderer/src/web/webApi.ts", {
	globals: {
		fetch: (...args) => fetchImpl(...args),
		Response: globalThis.Response,
	},
});

function jsonResponse(body, { ok = true, status = 200 } = {}) {
	return {
		ok,
		status,
		json: async () => body,
	};
}

/** 运行一次并捕获拒绝；返回捕获到的错误（未拒绝时返回 undefined）。 */
async function captureRejection(run) {
	try {
		await run();
		return undefined;
	} catch (error) {
		return error;
	}
}

test("stopRuntime posts the complete target and resolves the non-nested value", async () => {
	let captured;
	fetchImpl = async (url, init) => {
		captured = { url, init };
		return jsonResponse({ result: { ok: true, value: target } });
	};

	const resolved = await stopRuntime(target);

	assert.equal(captured.url, "/api/sessions/session-1/runtime/stop");
	assert.equal(captured.init.method, "POST");
	assert.deepEqual(JSON.parse(captured.init.body).target, target);
	// 关键回归：成功响应不能被读成 undefined（历史实现读了 value.value）
	assert.ok(resolved, "successful stop must resolve to the target object");
	assert.equal(resolved.sessionId, "session-1");
	assert.equal(resolved.agentId, "agent-1");
	assert.equal(resolved.runtimeGeneration, 3);
	assert.deepEqual(resolved, target);
});

test("stopRuntime rejects a runtime command failure with its code", async () => {
	fetchImpl = async () =>
		jsonResponse({ result: { ok: false, error: { code: "SESSION_RUNTIME_CHANGED" } } });

	const error = await captureRejection(() => stopRuntime(target));
	assert.ok(error, "runtime failure must reject");
	assert.equal(error.message, "SESSION_RUNTIME_CHANGED");
});

test("stopRuntime rejects an HTTP failure with the action and status", async () => {
	fetchImpl = async () => jsonResponse({ error: "nope" }, { ok: false, status: 500 });

	const error = await captureRejection(() => stopRuntime(target));
	assert.ok(error, "http failure must reject");
	assert.equal(error.message, "runtime stop 500");
});

test("stopRuntime rejects a malformed success payload", async () => {
	// 服务端异常返回缺失结构时，不得当成正常关闭
	fetchImpl = async () => jsonResponse({ result: { ok: true, value: undefined } });

	const error = await captureRejection(() => stopRuntime(target));
	assert.ok(error, "malformed success payload must reject");
	assert.equal(typeof error.message, "string");
	assert.ok(error.message.length > 0);
});

test("stopRuntime rejects a target identity mismatch", async () => {
	// 旧 runtimeGeneration 或换 agent/session 的回包不能冒充本次关闭成功
	const mismatched = [
		{ sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 2 },
		{ sessionId: "session-1", agentId: "agent-2", runtimeGeneration: 3 },
		{ sessionId: "other-session", agentId: "agent-1", runtimeGeneration: 3 },
	];

	for (const value of mismatched) {
		fetchImpl = async () =>
			jsonResponse({
				result: {
					ok: true,
					value,
				},
			});
		const error = await captureRejection(() => stopRuntime(target));
		assert.ok(error, `mismatched target must reject: ${JSON.stringify(value)}`);
		assert.equal(typeof error.message, "string");
		assert.ok(error.message.length > 0);
	}
});

test("deleteSession posts to the delete endpoint and returns true", async () => {
	let captured;
	fetchImpl = async (url, init) => {
		captured = { url, init };
		return jsonResponse({ deleted: true });
	};

	const result = await deleteSession("session-1");
	assert.equal(captured.url, "/api/sessions/session-1/delete");
	assert.equal(captured.init.method, "POST");
	assert.equal(result, true);
});

test("deleteSession rejects on 400 with backend error message", async () => {
	fetchImpl = async () =>
		jsonResponse({ error: "Cannot delete running session: stopBeforeDelete" }, { ok: false, status: 400 });

	const error = await captureRejection(() => deleteSession("session-1"));
	assert.ok(error);
	assert.match(error.message, /stopBeforeDelete/);
});

test("deleteSession rejects on 500 internal error", async () => {
	fetchImpl = async () =>
		jsonResponse({ error: "The web service encountered an internal error" }, { ok: false, status: 500 });

	const error = await captureRejection(() => deleteSession("session-1"));
	assert.ok(error);
	assert.match(error.message, /internal error/);
});

test("deleteSession rejects when deleted flag is not true", async () => {
	fetchImpl = async () => jsonResponse({ deleted: false });

	const error = await captureRejection(() => deleteSession("session-1"));
	assert.ok(error);
	assert.match(error.message, /delete session failed/);
});
