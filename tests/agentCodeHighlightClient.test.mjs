import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 高亮客户端调度器：Worker 生命周期、去重、排队、取消、超时、空闲回收。
 *
 * 这些规则决定「同步 shiki 计算是否真的离开了主线程」，只断言 UI 结果覆盖不到，
 * 因此这里直接测调度器本身。
 */

const clientModule = loadTsCommonJs(
	"src/renderer/src/components/agents/agentCodeHighlightClient.ts",
);
const typesModule = loadTsCommonJs(
	"src/renderer/src/components/agents/agentHighlightTypes.ts",
);

const { createAgentCodeHighlightClient } = clientModule;
const { parseHighlightResponse } = typesModule;

/** 可手工驱动的 Worker 替身：记录发出/终止的请求，并由测试决定何时回结果。 */
function createFakeWorker() {
	const state = {
		requests: [],
		terminated: 0,
		handler: null,
		subscribes: 0,
		unsubscribes: 0,
	};
	const port = {
		postMessage: (message) => {
			state.requests.push(message);
		},
		terminate: () => {
			state.terminated += 1;
		},
		subscribe: (handler) => {
			state.subscribes += 1;
			state.handler = handler;
			return () => {
				state.unsubscribes += 1;
				if (state.handler === handler) state.handler = null;
			};
		},
	};
	return {
		state,
		port,
		/** 回一个成功结果。 */
		respond(requestId, lines = [{ content: "x", offset: 0 }]) {
			state.handler?.({ type: "highlight-result", requestId, lines });
		},
		respondError(requestId, message = "boom") {
			state.handler?.({ type: "highlight-error", requestId, message });
		},
		lastRequestId() {
			return state.requests.at(-1)?.requestId;
		},
	};
}

/** 创建一个使用替身 Worker 的 client（createWorker 立即 resolve）。 */
function setup(options = {}) {
	const fake = createFakeWorker();
	let created = 0;
	const client = createAgentCodeHighlightClient({
		createWorker: async () => {
			created += 1;
			return fake.port;
		},
		...options,
	});
	return { client, fake, createdCount: () => created };
}

/** 让 ensureWorker 的微任务与 postMessage 链跑完。 */
async function flush() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

test("request posts a highlight message with a monotonic requestId", async () => {
	const { client, fake } = setup();
	const first = client.request("a", "diff");
	const second = client.request("b", "diff");
	await flush();
	assert.equal(fake.state.requests.length, 1, "only one task runs at a time");
	assert.equal(fake.state.requests[0].type, "highlight");
	assert.equal(fake.state.requests[0].code, "a");
	const firstId = fake.state.requests[0].requestId;
	fake.respond(firstId, [{ content: "A", offset: 0 }]);
	await flush();
	assert.equal(fake.state.requests.length, 2, "queued task starts after the first settles");
	assert.ok(
		fake.state.requests[1].requestId > firstId,
		"requestId must increase monotonically",
	);
	fake.respond(fake.state.requests[1].requestId, [{ content: "B", offset: 0 }]);
	assert.deepEqual(await first.promise, [{ content: "A", offset: 0 }]);
	assert.deepEqual(await second.promise, [{ content: "B", offset: 0 }]);
});

test("identical language+code requests share one worker task", async () => {
	const { client, fake } = setup();
	const first = client.request("same", "typescript");
	const second = client.request("same", "typescript");
	await flush();
	assert.equal(fake.state.requests.length, 1, "duplicate work must be deduped");
	fake.respond(fake.lastRequestId(), [{ content: "S", offset: 0 }]);
	assert.deepEqual(await first.promise, [{ content: "S", offset: 0 }]);
	assert.deepEqual(await second.promise, [{ content: "S", offset: 0 }]);
});

test("same code in a different language is a separate task", async () => {
	const { client, fake } = setup();
	const first = client.request("same", "typescript");
	const second = client.request("same", "diff");
	await flush();
	assert.equal(fake.state.requests.length, 1);
	fake.respond(fake.lastRequestId(), [{ content: "T", offset: 0 }]);
	await flush();
	assert.equal(fake.state.requests.length, 2, "different language must not be deduped");
	assert.equal(fake.state.requests[1].language, "diff");
	fake.respond(fake.state.requests[1].requestId, [{ content: "D", offset: 0 }]);
	assert.deepEqual(await first.promise, [{ content: "T", offset: 0 }]);
	assert.deepEqual(await second.promise, [{ content: "D", offset: 0 }]);
});

test("one worker is reused across sequential tasks", async () => {
	const { client, fake, createdCount } = setup();
	const first = client.request("a", "diff");
	await flush();
	assert.equal(createdCount(), 1);
	fake.respond(fake.lastRequestId());
	await first.promise;
	const second = client.request("b", "diff");
	await flush();
	assert.equal(createdCount(), 1, "worker must be reused");
	assert.equal(fake.state.terminated, 0);
	fake.respond(fake.lastRequestId());
	await second.promise;
	client.dispose();
});

test("cancelling one consumer does not cancel the shared task for others", async () => {
	const { client, fake } = setup();
	const first = client.request("same", "diff");
	const second = client.request("same", "diff");
	first.cancel();
	await flush();
	assert.equal(fake.state.requests.length, 1, "the task is still needed by the other consumer");
	fake.respond(fake.lastRequestId(), [{ content: "S", offset: 0 }]);
	assert.deepEqual(await second.promise, [{ content: "S", offset: 0 }]);
	// 取消的消费者不应被 resolve，也不应变成未处理拒绝。
	await assert.rejects(
		Promise.race([
			first.promise.then(() => {
				throw new Error("cancelled consumer must not resolve");
			}),
			new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 20)),
		]),
		/timeout/,
	);
});

test("cancelling the only consumer removes the queued task", async () => {
	const { client, fake } = setup();
	const running = client.request("running", "diff");
	await flush();
	const queued = client.request("queued", "diff");
	assert.equal(client.pendingTaskCount(), 2);
	queued.cancel();
	assert.equal(client.pendingTaskCount(), 1, "cancelled queued task must be dropped");
	fake.respond(fake.lastRequestId(), [{ content: "R", offset: 0 }]);
	await running.promise;
	await flush();
	assert.equal(fake.state.requests.length, 1, "the dropped task must never be posted");
});

test("worker error rejects the task", async () => {
	const { client, fake } = setup();
	const handle = client.request("bad", "diff");
	await flush();
	fake.respondError(fake.lastRequestId(), "grammar missing");
	await assert.rejects(handle.promise, /grammar missing/);
});

test("task timeout terminates the worker, rejects, and clears state", async () => {
	const { client, fake } = setup({ taskTimeoutMs: 5 });
	const running = client.request("slow", "diff");
	const queued = client.request("later", "diff");
	// 超时可能在 assert.rejects 挂上之前就发生：先附一个吸掉式处理器，避免未处理拒绝。
	void running.promise.catch(() => {});
	void queued.promise.catch(() => {});
	await flush();
	await new Promise((resolve) => setTimeout(resolve, 20));
	await assert.rejects(running.promise, /timed out/);
	await assert.rejects(queued.promise, /timed out/);
	assert.equal(fake.state.terminated, 1, "worker must be terminated after a timeout");
	assert.equal(client.pendingTaskCount(), 0, "timeout must clear queued tasks");
	assert.equal(client.hasWorker(), false);
});

test("a new request after a timeout creates a fresh worker", async () => {
	const { client, fake, createdCount } = setup({ taskTimeoutMs: 5 });
	const first = client.request("slow", "diff");
	void first.promise.catch(() => {});
	await flush();
	await new Promise((resolve) => setTimeout(resolve, 20));
	await assert.rejects(first.promise, /timed out/);
	const second = client.request("again", "diff");
	await flush();
	assert.equal(createdCount(), 2, "a fresh worker must be created");
	fake.respond(fake.lastRequestId(), [{ content: "N", offset: 0 }]);
	assert.deepEqual(await second.promise, [{ content: "N", offset: 0 }]);
});

test("idle teardown terminates the worker and resubscribes on the next request", async () => {
	const { client, fake, createdCount } = setup({ idleTeardownMs: 5 });
	const handle = client.request("a", "diff");
	await flush();
	fake.respond(fake.lastRequestId(), [{ content: "A", offset: 0 }]);
	await handle.promise;
	assert.equal(client.hasWorker(), true);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(client.hasWorker(), false, "idle worker must be released");
	assert.equal(fake.state.terminated, 1);
	assert.equal(fake.state.unsubscribes, 1, "listener must be removed with the worker");
	const next = client.request("b", "diff");
	await flush();
	assert.equal(createdCount(), 2);
	assert.equal(fake.state.subscribes, 2);
	fake.respond(fake.lastRequestId(), [{ content: "B", offset: 0 }]);
	assert.deepEqual(await next.promise, [{ content: "B", offset: 0 }]);
	client.dispose();
});

test("idle teardown does not fire while a task is queued", async () => {
	const { client, fake } = setup({ idleTeardownMs: 5 });
	const running = client.request("a", "diff");
	const queued = client.request("b", "diff");
	await flush();
	await new Promise((resolve) => setTimeout(resolve, 20));
	// 排队中的任务还没跑，Worker 不能被回收。
	assert.equal(client.hasWorker(), true);
	fake.respond(fake.lastRequestId(), [{ content: "A", offset: 0 }]);
	await running.promise;
	fake.respond(fake.lastRequestId(), [{ content: "B", offset: 0 }]);
	assert.deepEqual(await queued.promise, [{ content: "B", offset: 0 }]);
	client.dispose();
});

test("late results from an older request are ignored", async () => {
	const { client, fake } = setup();
	const first = client.request("a", "diff");
	await flush();
	const staleId = fake.lastRequestId();
	fake.respond(staleId, [{ content: "A", offset: 0 }]);
	await first.promise;
	const second = client.request("b", "diff");
	await flush();
	const liveId = fake.lastRequestId();
	// 旧请求的结果迟到：不能污染当前任务。
	fake.respond(staleId, [{ content: "STALE", offset: 0 }]);
	assert.equal(client.pendingTaskCount(), 1);
	fake.respond(liveId, [{ content: "B", offset: 0 }]);
	assert.deepEqual(await second.promise, [{ content: "B", offset: 0 }]);
});

test("worker creation failure rejects without a main-thread fallback", async () => {
	let created = 0;
	const client = createAgentCodeHighlightClient({
		createWorker: async () => {
			created += 1;
			throw new Error("no worker support");
		},
	});
	const handle = client.request("a", "diff");
	void handle.promise.catch(() => {});
	await flush();
	await assert.rejects(handle.promise, /no worker support/);
	assert.equal(created, 1);
	assert.equal(client.pendingTaskCount(), 0);
});

test("dispose rejects in-flight work and terminates the worker", async () => {
	const { client, fake } = setup();
	const running = client.request("a", "diff");
	void running.promise.catch(() => {});
	await flush();
	client.dispose();
	await assert.rejects(running.promise, /disposed/);
	assert.equal(fake.state.terminated, 1);
	assert.equal(client.hasWorker(), false);
});

test("worker creation timeout terminates a late-resolving worker", async (t) => {
	let resolveWorker;
	const fake = createFakeWorker();
	const client = createAgentCodeHighlightClient({
		taskTimeoutMs: 10,
		createWorker: () =>
			new Promise((resolve) => {
				resolveWorker = resolve;
			}),
	});
	t.after(() => {
		client.dispose();
	});

	const handle = client.request("slow-create", "diff");
	void handle.promise.catch(() => {});
	await flush();
	await new Promise((resolve) => setTimeout(resolve, 25));

	await assert.rejects(handle.promise, /timed out/);
	assert.equal(client.pendingTaskCount(), 0);
	assert.equal(client.hasWorker(), false);

	// 此时迟到的 Worker 创建才完成
	resolveWorker(fake.port);
	await flush();

	assert.equal(fake.state.terminated, 1, "late-created worker must be terminated immediately");
	assert.equal(fake.state.requests.length, 0, "late worker must not receive highlight requests");
	assert.equal(client.hasWorker(), false, "client must not adopt the late worker");
	assert.equal(client.pendingTaskCount(), 0);
});

test("stale worker creation does not overwrite a newer active worker", async (t) => {
	let resolveFirstWorker;
	let createdCount = 0;
	const firstFake = createFakeWorker();
	const secondFake = createFakeWorker();

	const client = createAgentCodeHighlightClient({
		taskTimeoutMs: 10,
		createWorker: () => {
			createdCount += 1;
			if (createdCount === 1) {
				return new Promise((resolve) => {
					resolveFirstWorker = resolve;
				});
			}
			return Promise.resolve(secondFake.port);
		},
	});
	t.after(() => {
		client.dispose();
	});

	// 第一个请求，在创建阶段超时
	const firstHandle = client.request("first", "diff");
	void firstHandle.promise.catch(() => {});
	await flush();
	await new Promise((resolve) => setTimeout(resolve, 25));
	await assert.rejects(firstHandle.promise, /timed out/);

	// 第二个请求，正常启动新 Worker
	const secondHandle = client.request("second", "diff");
	void secondHandle.promise.catch(() => {});
	await flush();
	assert.equal(secondFake.state.requests.length, 1, "second worker should receive task");

	// 此时第一个迟到的创建完成
	resolveFirstWorker(firstFake.port);
	await flush();

	assert.equal(firstFake.state.terminated, 1, "stale worker must be terminated");
	assert.equal(secondFake.state.terminated, 0, "active second worker must not be terminated");

	// 第二个任务正常出结果
	secondFake.respond(secondFake.lastRequestId(), [[{ content: "B", offset: 0 }]]);
	assert.deepEqual(await secondHandle.promise, [[{ content: "B", offset: 0 }]]);

	client.dispose();
	assert.equal(secondFake.state.terminated, 1, "dispose must terminate active second worker");
	assert.equal(client.hasWorker(), false);
});

test("parseHighlightResponse validates the worker boundary", () => {
	// 与 client 分属不同 vm 上下文（对象原型不同），因此比较结构化值。
	const plain = (value) => JSON.parse(JSON.stringify(value));
	assert.deepEqual(
		plain(parseHighlightResponse({ type: "highlight-result", requestId: 1, lines: [] })),
		{ type: "highlight-result", requestId: 1, lines: [] },
	);
	assert.equal(parseHighlightResponse(null), null);
	assert.equal(parseHighlightResponse("nope"), null);
	assert.equal(parseHighlightResponse({ type: "highlight-result", lines: [] }), null);
	assert.equal(
		parseHighlightResponse({ type: "highlight-result", requestId: 1, lines: "bad" }),
		null,
	);
	assert.equal(
		parseHighlightResponse({ type: "highlight-result", requestId: 1, lines: [[{ content: 1 }]] }),
		null,
	);
	assert.deepEqual(plain(parseHighlightResponse({ type: "highlight-error", requestId: 2 })), {
		type: "highlight-error",
		requestId: 2,
		message: "highlight failed",
	});
	assert.deepEqual(
		plain(parseHighlightResponse({ type: "highlight-error", requestId: 2, message: "x" })),
		{ type: "highlight-error", requestId: 2, message: "x" },
	);
	assert.equal(parseHighlightResponse({ type: "unknown", requestId: 3 }), null);
});
