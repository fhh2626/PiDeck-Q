import assert from "node:assert/strict";
import test from "node:test";
import { startCreateBackendHarness } from "./helpers/l4_createBackendHarness.mjs";

// The renderer consumes agent runtime output only through the per-session
// sessions:runtime-event envelope. Broadcasting the raw agents:* copy as well
// doubled serialization and SSE replay usage without any subscriber.
const RAW_WITHOUT_SUBSCRIBERS = [
	"agents:message",
	"agents:text-stream",
	"agents:thinking",
	"agents:state",
	"agents:runtime-state",
	"agents:subagent-status",
	"agents:ui-request",
	"agents:notice",
	"agents:log",
];

async function withBackend(action) {
	const sent = [];
	const bridgeEvents = [];
	const harness = await startCreateBackendHarness({
		sendToRenderer: (channel, ...args) => sent.push({ channel, args }),
		runtimeBridge: {
			emitSessionRuntimeEvent: (agentId, sourceChannel, payload) => {
				bridgeEvents.push({ agentId, sourceChannel, payload });
				return true;
			},
		},
	});
	try {
		const agentSender = harness.agentManagerArgs[0][1];
		await action({ agentSender, sent, bridgeEvents, outputListeners: harness.agentOutputListeners });
	} finally {
		await harness.dispose();
	}
}

test("assembled backend drops raw agent channels that have no renderer subscriber", async () => {
	await withBackend(({ agentSender, sent }) => {
		for (const channel of RAW_WITHOUT_SUBSCRIBERS) agentSender(channel, { agentId: "a" });
		assert.deepEqual(sent.map((entry) => entry.channel), []);
	});
});

test("assembled backend still broadcasts consumed raw agent channels unchanged", async () => {
	await withBackend(({ agentSender, sent }) => {
		const rpcLog = { agentId: "a", entries: [] };
		const trust = { requestId: "r", cwd: "/p", projectName: "p" };
		agentSender("agents:rpc-log", rpcLog);
		agentSender("projects:trust-request", trust);
		assert.deepEqual(sent, [
			{ channel: "agents:rpc-log", args: [rpcLog] },
			{ channel: "projects:trust-request", args: [trust] },
		]);
	});
});

test("every filtered agent output still reaches the session runtime envelope path", async () => {
	await withBackend(({ outputListeners, bridgeEvents }) => {
		assert.equal(outputListeners.length, 1);
		const expected = [];
		for (const sourceChannel of RAW_WITHOUT_SUBSCRIBERS) {
			const payload = sourceChannel === "agents:state"
				? { id: "a", status: "idle" }
				: { agentId: "a", value: sourceChannel };
			outputListeners[0](sourceChannel, sourceChannel === "agents:state" ? [payload] : payload);
			expected.push({ agentId: "a", sourceChannel, payload });
		}
		assert.deepEqual(bridgeEvents, expected);
	});
});

test("the filter is opt-out rather than discarding unknown agent channels", async () => {
	await withBackend(({ agentSender, sent }) => {
		const payload = { value: "future consumer" };
		agentSender("agents:future-extension", payload, "second argument");
		assert.deepEqual(sent, [{ channel: "agents:future-extension", args: [payload, "second argument"] }]);
	});
});
