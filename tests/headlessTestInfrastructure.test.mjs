import assert from "node:assert/strict";
import { connect } from "node:net";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { browserTestPlan } from "../scripts/test-browser.mjs";
import { encodeFrame, FakeHost } from "./helpers/native2BackendHarness.mjs";
import { Cdp, waitForText, within } from "./helpers/native2PackagedHost.mjs";
import { runInNewContext } from "node:vm";
import { connectFixturePage, readDebugEndpoint } from "./helpers/packagedCdpEndpoint.mjs";
import { isolatedDesktopCommand, ISOLATION_QUEUE_TIMEOUT_MS, ISOLATION_SELF_TEST_TIMEOUT_MS } from "./helpers/isolatedDesktop.mjs";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";

/** Read one real length-prefixed socket response, including split TCP packets. */
function response(socket) {
  return new Promise((resolveFrame, reject) => {
    let bytes = Buffer.alloc(0);
    const read = (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4 || bytes.length < bytes.readUInt32LE(0) + 4) return;
      socket.off("data", read);
      resolveFrame(JSON.parse(bytes.subarray(4, bytes.readUInt32LE(0) + 4).toString("utf8")));
    };
    socket.once("error", reject);
    socket.on("data", read);
  });
}

async function connection(t, handlers) {
  const host = new FakeHost({ handlers });
  const port = await host.start();
  t.after(() => host.stop());
  const socket = connect(port, "127.0.0.1");
  t.after(() => socket.destroy());
  await new Promise((resolveConnected, reject) => { socket.once("connect", resolveConnected); socket.once("error", reject); });
  return { host, socket };
}

test("unexpected fake-host calls fail promptly instead of waiting for production dialogs", async (t) => {
  const { socket } = await connection(t, {});
  const reply = response(socket);
  socket.write(encodeFrame({ type: "request", id: "unexpected", method: "dialog.unexpected", params: {} }));
  const result = await within(reply, 1000);
  assert.ok(result, "An undeclared host call must receive a diagnostic immediately");
  assert.equal(result.ok, false);
  assert.match(result.error.message, /unexpected.*dialog.unexpected/i);
});

test("declared unanswered host requests retain their explicit manual fixture barrier", async (t) => {
  const { host, socket } = await connection(t, { "test.deferred": () => undefined });
  const reply = response(socket);
  socket.write(encodeFrame({ type: "request", id: "barrier", method: "test.deferred", params: {} }));
  await host.waitForRequest("test.deferred");
  host.respond("barrier", { released: true });
  assert.deepEqual(await within(reply, 1000), { type: "response", id: "barrier", ok: true, result: { released: true } });
});

test("browser test plans reject all headed and interactive overrides before spawning", () => {
  for (const argument of ["--headed", "--headed=true", "--debug", "--ui", "--ui-host=127.0.0.1", "--ui-port=1234", "--config", "--config=headed.config.ts", "-c", "-cheaded.config.ts"])
    assert.throws(() => browserTestPlan([argument], {}), /unattended/);
  assert.throws(() => browserTestPlan([], { PWDEBUG: "1" }), /unattended/);
  const plan = browserTestPlan(["--reporter=html"], { PWDEBUG: "0" });
  assert.equal(plan.options.windowsHide, true);
  assert.equal(plan.options.env.PLAYWRIGHT_HTML_OPEN, "never");
  assert.equal(plan.options.env.PWDEBUG, "0");
  assert.ok(plan.args.includes("--reporter=html"));
});

/** A private profile and HTTP endpoint exercise discovery without any browser or UI. */
async function debugFixture(t, browserId = "owned-browser", pageHost = "127.0.0.1", onRequest = () => false) {
  const root = mkdtempSync(join(tmpdir(), "pideck-cdp-ownership-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const server = createServer((request, result) => {
    requests.push(request.url);
    if (onRequest(request, result)) return;
    result.setHeader("Content-Type", "application/json");
    result.end(JSON.stringify(request.url === "/json/version"
      ? { webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/${browserId}` }
      : [{ type: "page", webSocketDebuggerUrl: `ws://${pageHost}:${server.address().port}/devtools/page/page-id` }]));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => { server.close(resolveClose); server.closeAllConnections(); }));
  const debugPortFile = join(root, "DevToolsActivePort");
  writeFileSync(debugPortFile, `${server.address().port}\n/devtools/browser/owned-browser\n`);
  return { requests, debugPortFile, child: { exitCode: null }, output: {} };
}

test("a foreign server on the advertised port never receives CDP commands", async (t) => {
  const launch = await debugFixture(t, "foreign-browser");
  let connected = false;
  await assert.rejects(connectFixturePage(0, { launch, connectClient: () => { connected = true; } }), /ownership mismatch/);
  assert.equal(connected, false);
  assert.deepEqual(launch.requests, ["/json/version"]);
});

test("private CDP discovery rejects a target that redirects commands away from loopback", async (t) => {
  const launch = await debugFixture(t, "owned-browser", "example.invalid");
  await assert.rejects(connectFixturePage(0, { launch, connectClient: () => assert.fail("foreign target was connected") }), /ownership mismatch/);
});

test("private CDP discovery retries transient list and connection failures", async (t) => {
  let listFailures = 0;
  const launch = await debugFixture(t, "owned-browser", "127.0.0.1", (request, result) => {
    if (request.url === "/json/list" && listFailures++ === 0) {
      result.destroy();
      return true;
    }
    return false;
  });
  let attempts = 0;
  const result = await connectFixturePage(0, { launch, timeoutMs: 5000, connectClient: () => {
    if (attempts++ === 0) throw new Error("page not ready");
    return "connected";
  } });
  assert.equal(result.cdp, "connected");
  assert.equal(attempts, 2);
  assert.equal(listFailures, 3);
});

test("private endpoint discovery and station admission have independent boot budgets", async (t) => {
  const launch = await debugFixture(t);
  let release;
  launch.admitted = new Promise((resolveAdmission) => { release = resolveAdmission; });
  let clock = 0;
  const connected = connectFixturePage(1, { timeoutMs: 1000, launch, now: () => clock,
    connectClient: (url, options) => ({ url, timeoutMs: options.timeoutMs }) });
  assert.deepEqual(launch.requests, []);
  clock = 31000; // Virtual queue time: no real 30-second wait in this regression.
  release(true);
  const result = await connected;
  assert.match(result.cdp.url, /^ws:\/\/127\.0\.0\.1:/);
  assert.equal(result.cdp.timeoutMs, 1000, "queue time must not consume the boot deadline");
  assert.deepEqual(launch.requests, ["/json/version", "/json/list"]);
  assert.ok(readDebugEndpoint(launch.debugPortFile).port > 0);
});

test("native UI isolation never falls back when a pinned launcher is missing", { skip: process.platform !== "win32" }, () => {
  assert.throws(() => isolatedDesktopCommand(process.execPath, [], {
    PIDECK_ISOLATED_DESKTOP_EXECUTABLE: "build/definitely-missing-isolation-launcher.exe",
  }), /fallback is disabled/);
});

/** Evaluate the production DOM expression through a navigation's missing-body frames. */
function navigationClient(frames) {
  let reads = 0;
  return {
    text: Cdp.prototype.text,
    async evaluate(expression) {
      const text = frames[Math.min(reads++, frames.length - 1)];
      return runInNewContext(expression, { document: { body: text === null ? null : { innerText: text } } });
    },
    readCount: () => reads,
  };
}

test("packaged readiness waits through a navigation without a document body", async () => {
  const cdp = navigationClient([null, "PIDECK-Q fixture project"]);
  assert.equal(await waitForText(cdp, "PIDECK-Q", { timeoutMs: 1500 }), "PIDECK-Q fixture project");
  assert.equal(cdp.readCount(), 2);
});

test("an absent-text wait cannot succeed before the document body exists", async () => {
  const cdp = navigationClient([null, "Loading history sessions", "ready"]);
  assert.equal(await waitForText(cdp, "Loading history sessions", { absent: true, timeoutMs: 1500 }), "ready");
  assert.equal(cdp.readCount(), 3);
});

test("ordinary CDP text assertions still fail when the document body is missing", async () => {
  await assert.rejects(navigationClient([null]).text(), /innerText/);
});

const launcher = nativeBuildPaths("PiDeck-IsolatedDesktop").map((path) => resolve(path)).find(existsSync);
test("native isolation runs real HWND and clipboard checks away from the interactive station", {
  skip: process.platform !== "win32" || (!launcher && process.env.PIDECK_REQUIRE_BACKEND_TESTS !== "1"),
}, () => {
  assert.ok(launcher, "Build PiDeck-IsolatedDesktop before required native tests");
  const result = spawnSync(launcher, ["--self-test"], { encoding: "utf8", windowsHide: true, timeout: ISOLATION_SELF_TEST_TIMEOUT_MS });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /private HWND and clipboard verified/);
  const policy = spawnSync(launcher, ["--policy"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert.equal(policy.status, 0, policy.stderr);
  const timings = JSON.parse(policy.stdout);
  assert.ok(timings.queueMs > timings.targetMs + timings.cleanupMs, "a healthy owner must be allowed to release the station");
  assert.ok(ISOLATION_QUEUE_TIMEOUT_MS > timings.queueMs);
  assert.ok(ISOLATION_SELF_TEST_TIMEOUT_MS > timings.queueMs + 10000 + timings.cleanupMs);
});
