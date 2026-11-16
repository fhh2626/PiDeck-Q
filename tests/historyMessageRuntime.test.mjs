import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { activateHistoryMessageRuntime } = loadTsCommonJs("src/renderer/src/utils/historyMessageRuntime.ts", {
	stubs: { "../i18n": { t: (key) => key } },
});

function fixture(changeDuringActivation) {
	const expected = { kind: "history", sessionId: "session-1", filePath: "/saved.jsonl", runtimeGeneration: 4 };
	const runtime = { sessionId: expected.sessionId, agentId: "new-agent", runtimeGeneration: 5, status: "idle", sessionPath: expected.filePath };
	let context = { filePath: expected.filePath, runtimeGeneration: 4, status: "detached" };
	let target;
	let binds = 0;
	return {
		expected,
		runtime,
		bindCount: () => binds,
		deps: {
			readContext: () => context,
			activate: async () => {
				if (changeDuringActivation) context = changeDuringActivation(runtime);
				return { ok: true, value: runtime };
			},
			bind: (next) => {
				binds += 1;
				target = { sessionId: next.sessionId, agentId: next.agentId, runtimeGeneration: next.runtimeGeneration };
			},
			readTarget: () => target ?? (context?.agentId ? {
				sessionId: expected.sessionId, agentId: context.agentId, runtimeGeneration: context.runtimeGeneration,
			} : undefined),
		},
	};
}

test("history activation binds its fresh response when runtime events have not arrived", async () => {
	const f = fixture();
	const target = await activateHistoryMessageRuntime(f.expected, f.deps);
	assert.equal(target.agentId, "new-agent");
	assert.equal(target.runtimeGeneration, 5);
	assert.equal(f.bindCount(), 1);
});

test("history activation accepts matching runtime events arriving before the response", async () => {
	const f = fixture((runtime) => ({ filePath: runtime.sessionPath, ...runtime }));
	assert.equal((await activateHistoryMessageRuntime(f.expected, f.deps)).agentId, "new-agent");
});

test("history activation never resurrects a process stopped before its response", async () => {
	const f = fixture((runtime) => ({ filePath: runtime.sessionPath, runtimeGeneration: runtime.runtimeGeneration, status: "detached" }));
	await assert.rejects(activateHistoryMessageRuntime(f.expected, f.deps), /sessionCommand.runtimeChanged/);
	assert.equal(f.bindCount(), 0);
});

test("a delayed activation response preserves newer running or error state for the same binding", async () => {
	const atoms = loadTsCommonJs("src/renderer/src/atoms/session-atoms.ts");
	for (const status of ["running", "error"]) {
		const store = createStore();
		const expected = { kind: "history", sessionId: "saved", filePath: "/saved.jsonl", runtimeGeneration: 3 };
		const ready = { sessionId: "saved", agentId: "new", runtimeGeneration: 4, sessionPath: "/saved.jsonl", status: "idle" };
		store.set(atoms.sessionRuntimeByIdAtom, { saved: { runtimeGeneration: 3, status: "detached" } });
		await activateHistoryMessageRuntime(expected, {
			readContext: () => ({ filePath: "/saved.jsonl", ...store.get(atoms.sessionRuntimeByIdAtom).saved }),
			activate: async () => {
				store.set(atoms.sessionRuntimeByIdAtom, { saved: { agentId: "new", runtimeGeneration: 4, status } });
				return { ok: true, value: ready };
			},
			bind: (value) => store.set(atoms.bindSessionRuntimeAtom, value),
			readTarget: () => ({ sessionId: "saved", ...store.get(atoms.sessionRuntimeByIdAtom).saved }),
		});
		assert.equal(store.get(atoms.sessionRuntimeByIdAtom).saved.status, status);
	}
});

test("history activation rejects session deletion, file replacement, and a newer runtime", async () => {
	for (const changed of [
		() => undefined,
		(runtime) => ({ filePath: "/replacement.jsonl", ...runtime }),
		(runtime) => ({ filePath: runtime.sessionPath, ...runtime, agentId: "another-agent", runtimeGeneration: 6 }),
	]) {
		const f = fixture(changed);
		await assert.rejects(activateHistoryMessageRuntime(f.expected, f.deps), /sessionCommand.runtimeChanged/);
		assert.equal(f.bindCount(), 0);
	}
});

test("history command services read both owning-session caches and bind the fresh activation response", async () => {
	const atoms = loadTsCommonJs("src/renderer/src/atoms/session-atoms.ts");
	const selectors = loadTsCommonJs("src/renderer/src/atoms/session-selectors.ts", {
		stubs: { "./session-atoms": atoms },
	});
	const store = createStore();
	store.set(atoms.currentSessionIdAtom, "another-pane");
	store.set(atoms.sessionRecordsAtom, { saved: { id: "saved", filePath: "/saved.jsonl" } });
	store.set(atoms.sessionRuntimeByIdAtom, { saved: { runtimeGeneration: 3, status: "detached" } });
	const recent = { id: "recent", meta: { entryId: "recent-entry" } };
	const older = { id: "older", meta: { entryId: "older-entry" } };
	store.set(atoms.sessionMessagesCacheAtom, { saved: { messages: [recent], history: { messages: [older] } } });
	const { useSessionHistoryMessageServices } = loadTsCommonJs("src/renderer/src/hooks/useSessionHistoryMessageServices.ts", {
		stubs: {
			react: { useMemo: (factory) => factory() },
			jotai: { useStore: () => store },
			"../atoms/session-atoms": atoms,
			"../atoms/session-selectors": selectors,
			"../i18n": { t: (key) => key },
			"../desktopApi": { desktopApi: { sessions: { activateRuntime: async (sessionId) => ({ ok: true, value: {
				sessionId, agentId: "new-agent", runtimeGeneration: 4, status: "idle", sessionPath: "/saved.jsonl",
			} }) } } },
		},
	});
	const services = useSessionHistoryMessageServices();
	assert.equal(services.getMessageForSession("saved", "recent"), recent);
	assert.equal(services.getMessageForSession("saved", "older"), older);
	assert.equal(services.getMessageForSession("another-pane", "older"), undefined);
	const target = await services.activateHistoryRuntime({ kind: "history", sessionId: "saved", filePath: "/saved.jsonl", runtimeGeneration: 3 });
	assert.equal(target.sessionId, "saved");
	assert.equal(target.agentId, "new-agent");
	assert.equal(target.runtimeGeneration, 4);
	assert.equal(store.get(atoms.currentSessionIdAtom), "another-pane");
	assert.equal(store.get(atoms.sessionRuntimeByIdAtom).saved.agentId, "new-agent");
});
