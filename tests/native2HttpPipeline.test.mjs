import assert from "node:assert/strict";
import { connect } from "node:net";
import test from "node:test";
import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { appLogLines } from "./helpers/nativeAppLog.mjs";

const executable = resolveBackendExecutable();

test("late TCP bytes cannot replay an in-flight host action", {
  skip: !executable && process.env.PIDECK_REQUIRE_BACKEND_TESTS !== "1" ? "Requires native backend" : false,
}, async (t) => {
  assert.ok(executable);
  const session = await startBackendSession(t, {
    // A declared manual barrier. No real browser, desktop handler, or network is opened.
    hostHandlers: { "shell.openExternal": () => undefined },
  });
  const body = JSON.stringify({ channel: "app:open-external", args: ["https://example.invalid/pipeline"] });
  const request = `POST /__pideck/rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nx-pideck-token: ${session.token}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  const socket = connect({ host: "127.0.0.1", port: Number(new URL(session.baseUrl).port) });
  t.after(() => socket.destroy());
  socket.setNoDelay(true);
  socket.setTimeout(10_000, () => socket.destroy());
  let response = "", transportError;
  socket.on("data", (chunk) => { response += chunk.toString("utf8"); });
  socket.on("error", (error) => { transportError = error; });
  const closed = new Promise((resolve) => socket.once("close", resolve));
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(request);
  const action = await session.host.waitForRequest("shell.openExternal", 5000);
  // The first handler is demonstrably still awaiting its host response. This
  // exercises a later readyRead, independently of the coalesced-pipeline case.
  socket.write(request);
  const dropped = () => appLogLines(session.fixture).some((line) =>
    line.message === "Native event channel diagnostic" && line.detail?.kind === "pipelined-request-dropped");
  const deadline = Date.now() + 5000;
  while (!dropped() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(dropped(), "late pipelined bytes must be observed and dropped before response settlement");
  assert.equal(session.host.requests.filter((frame) => frame.method === "shell.openExternal").length, 1);
  session.host.respond(action.id, null);
  await closed;
  assert.ifError(transportError);
  assert.match(response, /"ok":true/);
  assert.equal(session.host.requests.filter((frame) => frame.method === "shell.openExternal").length, 1);
});
