import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { recoverRecentHistoryLoad } = loadTsCommonJs("src/main/pi/recoverRecentHistoryLoad.ts");
const changed = () => Object.assign(new Error("changed"), { code: "SESSION_HISTORY_CHANGED" });

test("a transient invalidated snapshot can be followed by one successful current load", async () => {
  let attempts = 0;
  assert.equal(await recoverRecentHistoryLoad(async () => {
    if (++attempts === 1) throw changed();
  }, () => true), true);
  assert.equal(attempts, 2);
});

test("persistent changes stop at two attempts and retain the original structured error", async () => {
  let attempts = 0;
  const error = changed();
  await assert.rejects(recoverRecentHistoryLoad(async () => { attempts++; throw error; }, () => true), (actual) => actual === error);
  assert.equal(attempts, 2);
});

test("non-snapshot failures are not blindly retried", async () => {
  let attempts = 0;
  await assert.rejects(recoverRecentHistoryLoad(async () => {
    attempts++; throw Object.assign(new Error("denied"), { code: "EACCES" });
  }, () => true), { code: "EACCES" });
  assert.equal(attempts, 1);
});

test("closed ownership prevents any read or retry", async () => {
  assert.equal(await recoverRecentHistoryLoad(async () => { assert.fail("closed owner must not load"); }, () => false), false);
});

test("closing or superseding an in-flight failed load suppresses recovery and terminal errors", async () => {
  let current = true;
  let attempts = 0;
  assert.equal(await recoverRecentHistoryLoad(async () => {
    attempts++; current = false; throw changed();
  }, () => current), false);
  assert.equal(attempts, 1);
});

test("a late successful load does not announce success for a replaced runtime", async () => {
  let current = true;
  assert.equal(await recoverRecentHistoryLoad(async () => { current = false; }, () => current), false);
});

test("重试前退避一次，最终失败后不再多等，等待期间所有权变化则放弃重试", async () => {
  const delays = [];
  const sleep = async (ms) => { delays.push(ms); };
  let attempts = 0;
  await assert.rejects(recoverRecentHistoryLoad(async () => { attempts++; throw changed(); }, () => true, { sleep, retryDelayMs: 77 }));
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [77]);

  let current = true;
  attempts = 0;
  assert.equal(await recoverRecentHistoryLoad(async () => { attempts++; throw changed(); }, () => current, {
    sleep: async () => { current = false; },
  }), false);
  assert.equal(attempts, 1);
});
