import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";

/**
 * Regressions for the dev-proxy test harness itself (`tests/helpers/native2MockVite.mjs`).
 *
 * Why a separate file that spawns child processes: the bug this pins down is a *leaked
 * handle*, and a leaked handle is invisible to an in-process assertion (the test runner
 * has plenty of its own timers) but fatal to `node --test`, which never exits while the
 * loop is held open. The child prints what it observed and then simply has to exit; a
 * leftover `setInterval` keeps it alive until the bounded `execFile` timeout turns the
 * hang into a failure.
 *
 * The historical defect: `waitFor` rejected on timeout but only cleared its interval on
 * the success path, so every timed-out wait left a 10 ms interval running forever. The
 * dev-proxy suite waits for frames and closes constantly; one failed wait would hang the
 * whole required gate instead of reporting a failed assertion.
 */

const helperUrl = new URL("./helpers/native2MockVite.mjs", import.meta.url).href;

/** Run an ES module snippet in a child and return its JSON stdout. */
function runChild(source, { timeoutMs = 20_000 } = {}) {
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			["--input-type=module", "-e", source],
			{ timeout: timeoutMs, windowsHide: true },
			(error, stdout, stderr) => {
				if (error) {
					reject(
						new Error(
							`fixture child did not exit cleanly (${error.message})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
						),
					);
					return;
				}
				try {
					resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
				} catch {
					reject(new Error(`fixture child printed no JSON: ${stdout}\n${stderr}`));
				}
			},
		);
	});
}

test("waitFor timeout rejects, reports the message, and leaves no timer behind", async () => {
	const result = await runChild(`
import { waitFor } from ${JSON.stringify(helperUrl)};
const started = Date.now();
let message = "";
try {
	await waitFor(() => false, { timeoutMs: 150, message: "never-true predicate" });
} catch (error) {
	message = error.message;
}
const elapsedMs = Date.now() - started;
const timers = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
console.log(JSON.stringify({ message, elapsedMs, timers }));
`);
	assert.match(result.message, /timed out waiting for never-true predicate/);
	assert.ok(result.elapsedMs >= 100, `timed out too early: ${result.elapsedMs} ms`);
	assert.ok(result.elapsedMs < 5_000, `timeout was not respected: ${result.elapsedMs} ms`);
	assert.equal(result.timers, 0, "a rejected waitFor left an active timer");
});

test("waitFor resolve clears both the poll timer and the deadline", async () => {
	const result = await runChild(`
import { waitFor } from ${JSON.stringify(helperUrl)};
let polls = 0;
await waitFor(() => ++polls >= 4, { timeoutMs: 2_000, message: "four polls" });
const timers = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
console.log(JSON.stringify({ polls, timers }));
`);
	assert.equal(result.polls, 4);
	assert.equal(result.timers, 0, "a resolved waitFor left an active timer");
});

test("waitFor propagates a throwing predicate instead of polling forever", async () => {
	const result = await runChild(`
import { waitFor } from ${JSON.stringify(helperUrl)};
let message = "";
try {
	await waitFor(() => { throw new Error("predicate exploded"); }, { timeoutMs: 5_000 });
} catch (error) {
	message = error.message;
}
const timers = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
console.log(JSON.stringify({ message, timers }));
`);
	assert.equal(result.message, "predicate exploded");
	assert.equal(result.timers, 0);
});

test("MockVite.stop closes a hung request socket so the process can exit", async () => {
	const result = await runChild(`
import { connect } from "node:net";
import { MockVite } from ${JSON.stringify(helperUrl)};
const vite = await new MockVite({ routes: { "/hang.js": { hang: true } } }).start();
const socket = connect({ host: "127.0.0.1", port: vite.port });
await new Promise((resolve, reject) => {
	socket.once("connect", resolve);
	socket.once("error", reject);
});
socket.write("GET /hang.js HTTP/1.1\\r\\nhost: mock\\r\\nconnection: keep-alive\\r\\n\\r\\n");
await new Promise((resolve) => setTimeout(resolve, 50));
const socketsBefore = vite.sockets.size;
await vite.stop();
socket.destroy();
console.log(JSON.stringify({ socketsBefore, socketsAfter: vite.sockets.size, server: vite.server }));
`);
	assert.equal(result.socketsBefore, 1, "mock vite did not accept the request socket");
	assert.equal(result.socketsAfter, 0, "stop() left a socket tracked");
	assert.equal(result.server, null, "stop() left the listener");
});

test("RawWebSocketClient.connect rejects when the peer closes before the handshake", async () => {
	const result = await runChild(`
import { createServer } from "node:net";
import { RawWebSocketClient } from ${JSON.stringify(helperUrl)};
const server = createServer((socket) => socket.destroy());
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const client = new RawWebSocketClient(undefined, { path: "/hmr" });
let message = "";
try {
	await client.connect(server.address().port);
} catch (error) {
	message = error.message;
}
await new Promise((resolve) => server.close(resolve));
console.log(JSON.stringify({ message }));
`);
	// Both endings are bounded refusals: a clean FIN reaches the `close` branch and an RST
	// surfaces as `ECONNRESET`. What matters is that `connect()` settles instead of hanging.
	assert.match(result.message, /closed before \/hmr completed the handshake|ECONNRESET/);
});
