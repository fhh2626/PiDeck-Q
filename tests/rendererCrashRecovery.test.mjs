import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function compile(filePath) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
  return module.exports;
}

const recovery = compile("src/main/window/rendererCrashRecovery.ts");

/** 可控时钟工厂：now 从 0 起步，advance(ms) 推进。 */
function clock() {
  let current = 0;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

test("clean-exit never triggers auto reload", () => {
  const c = clock();
  const guard = recovery.createRendererCrashRecoveryGuard({ now: c.now });
  assert.equal(guard.shouldAutoReload("clean-exit"), false);
  assert.equal(guard.recoveriesInWindow(), 0);
});

test("crashed/oom reasons trigger auto reload and count toward the window", () => {
  const c = clock();
  const guard = recovery.createRendererCrashRecoveryGuard({ now: c.now });
  assert.equal(guard.shouldAutoReload("crashed"), true);
  assert.equal(guard.shouldAutoReload("oom"), true);
  assert.equal(guard.recoveriesInWindow(), 2);
});

test("crash storm beyond the limit stops auto reloading within the window", () => {
  const c = clock();
  const guard = recovery.createRendererCrashRecoveryGuard({ now: c.now });
  assert.equal(guard.shouldAutoReload("crashed"), true);
  assert.equal(guard.shouldAutoReload("crashed"), true);
  // 第 3 次仍在 60s 窗口内：拒绝恢复，避免无限重启循环
  assert.equal(guard.shouldAutoReload("crashed"), false);
  assert.equal(guard.recoveriesInWindow(), 2);
});

test("recoveries outside the window do not count toward the limit", () => {
  const c = clock();
  const guard = recovery.createRendererCrashRecoveryGuard({ now: c.now });
  guard.shouldAutoReload("crashed");
  guard.shouldAutoReload("crashed");
  assert.equal(guard.shouldAutoReload("crashed"), false);
  // 窗口期过后恢复计数清空，再次允许自动恢复
  c.advance(recovery.RENDERER_CRASH_RECOVERY_WINDOW_MS + 1);
  assert.equal(guard.recoveriesInWindow(), 0);
  assert.equal(guard.shouldAutoReload("crashed"), true);
});

const { shouldReloadAfterMissedHeartbeats } = loadTsCommonJs(
  "src/native-node/transport/nativeHeartbeatWatchdog.ts",
);
/** 与生产默认窗口一致：15 秒一个心跳窗口，连续 3 个窗口无心跳才重载。 */
const WINDOW_MS = 15_000;

test("heartbeat watchdog does not reload while fewer than three full windows were missed", () => {
  assert.equal(shouldReloadAfterMissedHeartbeats(0), false);
  // 渲染进程短暂卡顿（一个或两个窗口）不应触发整页重载
  assert.equal(shouldReloadAfterMissedHeartbeats(WINDOW_MS), false);
  assert.equal(shouldReloadAfterMissedHeartbeats(2 * WINDOW_MS), false);
  assert.equal(shouldReloadAfterMissedHeartbeats(3 * WINDOW_MS - 1), false);
});

test("heartbeat watchdog reloads once three full windows were missed", () => {
  assert.equal(shouldReloadAfterMissedHeartbeats(3 * WINDOW_MS), true);
  assert.equal(shouldReloadAfterMissedHeartbeats(10 * WINDOW_MS), true);
});

test("heartbeat watchdog treats negative elapsed time (clock skew) as no missed heartbeats", () => {
  assert.equal(shouldReloadAfterMissedHeartbeats(-5 * WINDOW_MS), false);
});

test("heartbeat watchdog honours custom window size and missed-window threshold", () => {
  assert.equal(shouldReloadAfterMissedHeartbeats(1_999, { windowMs: 1_000, missedWindowsBeforeReload: 2 }), false);
  assert.equal(shouldReloadAfterMissedHeartbeats(2_000, { windowMs: 1_000, missedWindowsBeforeReload: 2 }), true);
  // 非法配置（0 / 0.5）被钳到最小值 1，避免除零或永远重载
  assert.equal(shouldReloadAfterMissedHeartbeats(0, { windowMs: 0, missedWindowsBeforeReload: 0 }), false);
  assert.equal(shouldReloadAfterMissedHeartbeats(5, { windowMs: 0, missedWindowsBeforeReload: 10 }), false);
  assert.equal(shouldReloadAfterMissedHeartbeats(1, { windowMs: 0, missedWindowsBeforeReload: 0.5 }), true);
});

// 看门狗控制器（定时器 tick -> 判定 -> 重载 + 去重 + 宽限期重置）：用注入的假时钟驱动，不依赖入口脚本。
const { createRendererHeartbeatWatchdog } = loadTsCommonJs(
  "src/native-node/transport/nativeHeartbeatWatchdog.ts",
);

const POLL_MS = 3_000;

/** 按真实 3 秒轮询推进。一次跳过整段超时会被当成 sidecar 挂起，不能用来模拟渲染层失联。 */
function elapse(h, ms) {
  let left = ms;
  while (left > 0) {
    const step = Math.min(POLL_MS, left);
    h.advance(step);
    h.watchdog.tick();
    left -= step;
  }
}

function createWatchdogHarness({ shouldWatch = true, logThrows = false, logRejects = false, reloadThrows = false } = {}) {
  let now = 1_000_000;
  const harness = {
    reloads: 0,
    logs: 0,
    pending: [],
    watch: shouldWatch,
    advance: (ms) => { now += ms; },
  };
  harness.watchdog = createRendererHeartbeatWatchdog({
    now: () => now,
    shouldWatch: () => harness.watch,
    reload: () => {
      harness.reloads += 1;
      if (reloadThrows) throw new Error("synchronous reload failure");
      return new Promise((resolve, reject) => { harness.pending.push({ resolve, reject }); });
    },
    onReload: () => {
      harness.logs += 1;
      if (logThrows) throw new Error("diagnostic failure");
      if (logRejects) return Promise.reject(new Error("async diagnostic failure"));
    },
  });
  /** 让 reload 的 promise 链（catch/finally）跑完。 */
  harness.settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
  return harness;
}

test("renderer heartbeat watchdog reloads only after three silent windows and reports it once", () => {
  const h = createWatchdogHarness();
  elapse(h, 3 * WINDOW_MS - 1);
  assert.equal(h.reloads, 0);
  h.advance(1);
  h.watchdog.tick();
  assert.equal(h.reloads, 1);
  assert.equal(h.logs, 1);
});

test("renderer heartbeats keep resetting the silence clock", () => {
  const h = createWatchdogHarness();
  for (let i = 0; i < 10; i += 1) {
    elapse(h, 2 * WINDOW_MS); // 每次都接近但未到阈值
    h.watchdog.touch();
  }
  assert.equal(h.reloads, 0);
});

test("a lid-close sized tick gap restarts the grace period instead of reloading", () => {
  const h = createWatchdogHarness();
  h.advance(89_000);
  h.watchdog.tick();
  assert.equal(h.reloads, 0);
  elapse(h, 3 * WINDOW_MS - 1);
  assert.equal(h.reloads, 0, "sleep time must not count toward the next silence window");
  h.advance(1);
  h.watchdog.tick();
  assert.equal(h.reloads, 1);
});

test("a slow poll shorter than one reload window still counts toward silence", () => {
  const h = createWatchdogHarness();
  elapse(h, 2 * WINDOW_MS);
  h.advance(12_000);
  h.watchdog.tick();
  assert.equal(h.reloads, 0);
  h.advance(3_000);
  h.watchdog.tick();
  assert.equal(h.reloads, 1, "a hitch below the reload window must not discard accumulated silence");
});

test("renderer heartbeat watchdog does not judge a window that is hidden or being destroyed", () => {
  const h = createWatchdogHarness({ shouldWatch: false });
  elapse(h, 10 * WINDOW_MS);
  assert.equal(h.reloads, 0);
});

test("renderer heartbeat watchdog never starts a second reload while one is in flight", async () => {
  const h = createWatchdogHarness();
  elapse(h, 5 * WINDOW_MS);
  h.watchdog.tick();
  assert.equal(h.reloads, 1);

  // 重载结束后才恢复判定；并且重置了计时起点，新页面获得完整宽限期，不会立刻再重载（避免重载循环）。
  h.pending[0].resolve();
  await h.settle();
  h.watchdog.tick();
  assert.equal(h.reloads, 1, "the grace period restarts after the reload finished");
  elapse(h, 3 * WINDOW_MS);
  assert.equal(h.reloads, 2, "a page that stays silent is reloaded again");
});

test("a failing diagnostic hook cannot prevent reload or disable the watchdog", async () => {
  const h = createWatchdogHarness({ logThrows: true });
  assert.doesNotThrow(() => elapse(h, 3 * WINDOW_MS));
  assert.equal(h.reloads, 1);
  h.pending[0].resolve();
  await h.settle();
  elapse(h, 3 * WINDOW_MS);
  assert.equal(h.reloads, 2);
});

test("an asynchronous diagnostic rejection does not become an unhandled rejection", async () => {
  const h = createWatchdogHarness({ logRejects: true });
  elapse(h, 3 * WINDOW_MS);
  h.pending[0].resolve();
  await h.settle();
  elapse(h, 3 * WINDOW_MS);
  h.pending[1].resolve();
  await h.settle();
  assert.equal(h.reloads, 2);
});

test("a synchronous reload failure releases the guard and grants fresh grace", async () => {
  const h = createWatchdogHarness({ reloadThrows: true });
  assert.doesNotThrow(() => elapse(h, 3 * WINDOW_MS));
  await h.settle();
  h.watchdog.tick();
  assert.equal(h.reloads, 1);
  elapse(h, 3 * WINDOW_MS);
  assert.equal(h.reloads, 2);
});

test("a failed reload request still releases the in-flight guard and restarts the grace period", async () => {
  const h = createWatchdogHarness();
  elapse(h, 4 * WINDOW_MS);
  h.pending[0].reject(new Error("host gone"));
  await h.settle();

  h.watchdog.tick();
  assert.equal(h.reloads, 1);
  elapse(h, 3 * WINDOW_MS);
  assert.equal(h.reloads, 2, "the guard was released after the failure");
});
