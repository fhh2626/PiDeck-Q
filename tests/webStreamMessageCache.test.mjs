import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** Deterministic hook scheduler: effects commit after render, refs persist across renders. */
function harness() {
	const refs = [];
	let cursor = 0;
	let effects = [];
	const { useWebStreamMessageCache } = loadTsCommonJs("src/renderer/src/web/useWebStreamMessageCache.ts", {
		stubs: { react: {
			useRef: (initial) => { const index = cursor++; refs[index] ??= { current: initial }; return refs[index]; },
			useEffect: (effect) => effects.push(effect),
		} },
	});
	const cache = { current: {} };
	const writes = [];
	return {
		cache, writes,
		render: (messages, streaming, sessionId = "session") => {
			cursor = 0; effects = [];
			useWebStreamMessageCache({ sessionId, messages, streaming, cache, setMessages: (value) => writes.push(value) });
			for (const effect of effects) effect();
		},
	};
}
const user = (id) => ({ id, role: "user", parts: [{ type: "text", text: id }] });
const answer = (text) => ({ id: "stream", role: "assistant", parts: [{ type: "text", text }] });

test("stream cache merges a live tail without discarding older loaded pages or writing useChat", () => {
	const h = harness();
	h.cache.current.session = [user("old-user")];
	h.render([user("new-user"), answer("Partial")], true);
	assert.deepEqual(Array.from(h.cache.current.session, (m) => m.id), ["old-user", "new-user", "stream"]);
	assert.equal(h.writes.length, 0);
});

test("ready transition commits the final text frame before a snapshot reads the cache", () => {
	const h = harness();
	h.render([user("user"), answer("Partial")], true);
	h.render([user("user"), answer("Partial and final suffix")], false);
	assert.equal(h.cache.current.session.at(-1).parts[0].text, "Partial and final suffix");
});

test("a batched short stream still commits its terminal tool output in ready state", () => {
	const h = harness();
	const final = { id: "stream", role: "assistant", parts: [
		{ type: "tool-read", toolCallId: "call", state: "output-available", input: {}, output: "done" },
	] };
	h.cache.current.session = [user("old-user")];
	h.render([user("new-user"), final], false);
	assert.equal(h.cache.current.session.at(-1).parts[0].output, "done");
	assert.equal(h.cache.current.session.length, 3);
	assert.equal(h.writes.length, 1);
});

test("cloned useChat ready arrays do not cause repeated writeback", () => {
	const h = harness();
	h.cache.current.session = [user("old-user")];
	h.render([user("new-user"), answer("Complete")], false);
	const committed = h.writes[0];
	assert.ok(committed);
	for (let i = 0; i < 4; i++) h.render([...committed], false);
	assert.equal(h.writes.length, 1);
});

/** A PC tail may already be cached while the visible useChat baseline is still older. */
test("a new Web turn stays after the cached PC tail during streaming and settlement", () => {
	const h = harness();
	const original = user("original");
	const earlierReply = { id: "earlier", role: "assistant", metadata: { chatRole: "assistant", timestamp: 2, entryId: "earlier" }, parts: [{ type: "text", text: "earlier" }] };
	const pcTool = { id: "pc-tool", role: "assistant", metadata: { chatRole: "tool", timestamp: 3, toolCallId: "pc-write" }, parts: [{ type: "tool-write", toolCallId: "pc-write", state: "output-available", input: {}, output: "done" }] };
	const pcReply = { id: "pc-reply", role: "assistant", metadata: { chatRole: "assistant", timestamp: 4, entryId: "pc-reply" }, parts: [{ type: "text", text: "PC reply" }] };
	h.cache.current.session = [original, earlierReply, pcTool, pcReply];
	const live = [original, earlierReply, user("new-user"), answer("New Web response")];
	h.render(live, true);
	assert.deepEqual(Array.from(h.cache.current.session, (m) => m.id), ["original", "earlier", "pc-tool", "pc-reply", "new-user", "stream"]);
	assert.equal(h.writes.length, 0, "never replace useChat mid-stream");
	h.render(live, false);
	assert.deepEqual(Array.from(h.writes.at(-1), (m) => m.id), ["original", "earlier", "pc-tool", "pc-reply", "new-user", "stream"]);
});

test("switching session does not flush the previous stream into the new session", () => {
	const h = harness();
	h.render([user("old-user"), answer("Partial")], true, "old");
	h.render([], false, "new");
	assert.equal(h.cache.current.new, undefined);
	assert.equal(h.cache.current.old.at(-1).parts[0].text, "Partial");
	assert.equal(h.writes.length, 0);
});
