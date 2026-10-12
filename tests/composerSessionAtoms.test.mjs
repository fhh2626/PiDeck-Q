import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const atoms = loadTsCommonJs("src/renderer/src/atoms/composer-atoms.ts");

test("updating another session's draft does not notify this session's subscriber", () => {
	const store = createStore();
	let notified = 0;
	store.sub(atoms.sessionDraftAtomFamily("a"), () => {
		notified++;
	});
	store.set(atoms.setSessionDraftAtom, { sessionId: "b", value: "hello" });
	assert.equal(notified, 0, "其他会话的草稿更新不得通知本会话订阅者");
	store.set(atoms.setSessionDraftAtom, { sessionId: "a", value: "hi" });
	assert.equal(notified, 1);
});

test("switching another session's composer mode does not notify this session's subscriber", () => {
	const store = createStore();
	let notified = 0;
	store.sub(atoms.sessionComposerModeAtomFamily("a"), () => {
		notified++;
	});
	store.set(atoms.setSessionComposerModeAtom, { sessionId: "b", mode: "plan" });
	assert.equal(notified, 0);
	store.set(atoms.setSessionComposerModeAtom, { sessionId: "a", mode: "plan" });
	assert.equal(notified, 1);
});

test("default attachments and send state keep a stable reference", () => {
	const store = createStore();
	const first = store.get(atoms.sessionAttachmentsAtomFamily("x"));
	store.set(atoms.setSessionDraftAtom, { sessionId: "y", value: "z" });
	assert.equal(store.get(atoms.sessionAttachmentsAtomFamily("x")), first);
	// 暂存的空数组/空闲状态每次读取必须是同一引用，否则依赖它的 memo/effect 会误触发。
	assert.equal(
		store.get(atoms.sessionSendStateAtomFamily("x")),
		store.get(atoms.sessionSendStateAtomFamily("x")),
	);
	assert.equal(JSON.stringify(store.get(atoms.sessionSendStateAtomFamily("x"))), '{"status":"idle"}');
});

test("removing a session drops its per-session composer atoms", async () => {
	const store = createStore();
	store.set(atoms.setSessionDraftAtom, { sessionId: "gone", value: "draft" });
	assert.equal(store.get(atoms.sessionDraftAtomFamily("gone")), "draft");
	await store.set(atoms.removeSessionComposerStateAtom, "gone");
	assert.equal(store.get(atoms.sessionDraftAtomFamily("gone")), "");
});
