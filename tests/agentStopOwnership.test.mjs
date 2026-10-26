import assert from "node:assert/strict";
import test from "node:test";
import { createAgentManagerHarness } from "./helpers/l2_agentManagerHarness.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));

/** Hold the process boundary, not AgentManager's runtime bookkeeping. */
function holdStop(process) {
	let release;
	const pending = new Promise(resolve => { release = resolve; });
	process.stop = () => pending;
	return () => release(true);
}

test("stop retains session ownership and does not resolve before process exit", async () => {
	const h = createAgentManagerHarness();
	const input = { projectId: h.project.id, sessionPath: h.sessionPath, deckSessionId: "session" };
	const tab = await h.manager.create(input);
	const release = holdStop(h.processes[0]);
	let stopped = false;
	const stopping = h.manager.stop(tab.id).then(() => { stopped = true; });
	try {
		await flush();
		assert.equal(stopped, false, "coordinator must not unbind a still-live process");
		assert.equal(h.manager.list().some(item => item.id === tab.id), true);
		await h.manager.create(input);
		assert.equal(h.processes.length, 1, "a pending stop still owns the session file");
	} finally {
		release();
		await stopping;
		await h.manager.stopAll();
	}
});

test("stop reports failure without releasing an unterminated runtime", async () => {
	const h = createAgentManagerHarness();
	const tab = await h.manager.create({ projectId: h.project.id, deckSessionId: "session" });
	h.processes[0].stop = async () => false;
	try {
		await assert.rejects(h.manager.stop(tab.id), /did not exit/);
		assert.equal(h.manager.list().some(item => item.id === tab.id), true);
	} finally {
		h.processes[0].stop = async () => true;
		await h.manager.stopAll();
	}
});

test("stopAll invalidates a restart already waiting for the old process", async () => {
	const h = createAgentManagerHarness();
	const tab = await h.manager.create({ projectId: h.project.id, deckSessionId: "session" });
	const release = holdStop(h.processes[0]);
	const restarting = assert.rejects(h.manager.restart(tab.id), /cancelled/);
	await flush();
	const stopping = h.manager.stopAll();
	release();
	try {
		await stopping;
		await restarting;
		assert.equal(h.processes.length, 1, "shutdown must not spawn a replacement");
		assert.deepEqual([...h.manager.list()], []);
	} finally {
		await h.manager.stopAll();
	}
});

test("user stop cancels an in-flight restart instead of spawning after stop", async () => {
	const h = createAgentManagerHarness();
	const tab = await h.manager.create({ projectId: h.project.id, deckSessionId: "session" });
	const release = holdStop(h.processes[0]);
	const restarting = assert.rejects(h.manager.restart(tab.id), /cancelled/);
	await flush();
	const stopping = h.manager.stop(tab.id);
	release();
	try {
		await stopping;
		await restarting;
		assert.equal(h.processes.length, 1);
		assert.deepEqual([...h.manager.list()], []);
	} finally {
		await h.manager.stopAll();
	}
});
