import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { reconcileWebStreamRuntime } = loadTsCommonJs("src/main/web/webStreamRuntime.ts");
const runtime = { sessionId: "session", agentId: "agent", runtimeGeneration: 1, projectId: "project",
	cwd: "/fixture", status: "running", createdAt: 1 };
const target = { sessionId: runtime.sessionId, agentId: runtime.agentId, runtimeGeneration: runtime.runtimeGeneration };

test("a pending POST cannot be closed by the pre-dispatch idle/missing runtime", () => {
	assert.equal(reconcileWebStreamRuntime(undefined, undefined).finish, false);
	assert.equal(reconcileWebStreamRuntime(undefined, { ...runtime, status: "idle" }).finish, false);
	assert.equal(reconcileWebStreamRuntime(undefined, { ...runtime, status: "starting" }).finish, false);
	assert.equal(reconcileWebStreamRuntime(undefined, { ...runtime, status: "starting" }, "dispatch").target, undefined);
});

test("a GET with nothing to observe ends promptly instead of leaking a socket", () => {
	for (const status of ["idle", "closed", "error"]) {
		assert.equal(reconcileWebStreamRuntime(undefined, { ...runtime, status }, "observe").finish, true);
	}
	assert.equal(reconcileWebStreamRuntime(undefined, undefined, "observe").finish, true);
});

test("a cold GET pins a transient starting runtime so its end still closes the stream", () => {
	const pinned = reconcileWebStreamRuntime(undefined, { ...runtime, status: "starting" }, "observe");
	assert.equal(pinned.finish, false);
	assert.equal(pinned.target.runtimeGeneration, target.runtimeGeneration);
	assert.equal(pinned.target.agentId, target.agentId);
	assert.equal(reconcileWebStreamRuntime(pinned.target, { ...runtime, status: "running" }, "observe").finish, false);
	assert.equal(reconcileWebStreamRuntime(pinned.target, { ...runtime, status: "idle" }, "observe").finish, true);
	assert.equal(reconcileWebStreamRuntime(pinned.target, undefined, "observe").finish, true);
});

test("the stream pins an immutable identity once a runtime starts running", () => {
	const mutable = { ...runtime };
	const decision = reconcileWebStreamRuntime(undefined, mutable);
	mutable.runtimeGeneration++;
	assert.equal(decision.target.runtimeGeneration, 1);
	assert.equal(reconcileWebStreamRuntime(decision.target, mutable).finish, true);
});

test("a running or temporarily starting runtime keeps its observed stream open", () => {
	assert.equal(reconcileWebStreamRuntime(target, runtime).finish, false);
	assert.equal(reconcileWebStreamRuntime(target, { ...runtime, status: "starting" }).finish, false);
});

test("idle, closed, error and missing runtime end a previously observed execution", () => {
	for (const status of ["idle", "closed", "error"]) {
		assert.equal(reconcileWebStreamRuntime(target, { ...runtime, status }).finish, true);
	}
	assert.equal(reconcileWebStreamRuntime(target, undefined).finish, true);
});

test("a replacement run uses a fresh fence rather than inheriting its predecessor's identity", () => {
	const replacement = { ...runtime, agentId: "replacement", runtimeGeneration: 2 };
	assert.equal(reconcileWebStreamRuntime(target, replacement).finish, true);
	const fresh = reconcileWebStreamRuntime(undefined, replacement);
	assert.equal(fresh.finish, false);
	assert.equal(fresh.target.agentId, "replacement");
});
