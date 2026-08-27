import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/renderer/src/native/NativeDesktopTransport.ts", "utf8");

test("native RPC aborts bounded calls and clears the timeout", () => {
  assert.match(source, /const controller = new AbortController\(\);/);
  assert.match(source, /controller\.abort\(\);/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /finally \{\s*if \(timer\) clearTimeout\(timer\);/s);
  assert.match(source, /Native RPC timed out after \$\{timeoutMs\}ms/);
});

test("native RPC keeps prompt delivery unbounded but bounds history and file calls", () => {
  assert.match(source, /if \(channel === "sessions:send-prompt"\) return undefined;/);
  assert.match(source, /if \(channel\.startsWith\("sessions:catalog-"\)\) return NATIVE_HISTORY_RPC_TIMEOUT_MS;/);
  assert.match(source, /if \(channel\.startsWith\("files:"\)\) return NATIVE_FILE_RPC_TIMEOUT_MS;/);
  assert.match(source, /const NATIVE_RPC_TIMEOUT_MS = 30_000;/);
  assert.match(source, /const NATIVE_HISTORY_RPC_TIMEOUT_MS = 60_000;/);
  assert.match(source, /const NATIVE_FILE_RPC_TIMEOUT_MS = 60_000;/);
});
