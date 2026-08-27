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

test("native RPC bounds only the explicit read-only allowlist", () => {
  assert.match(source, /const NATIVE_READ_RPC_TIMEOUT_MS = 60_000;/);
  assert.match(source, /const NATIVE_READONLY_RPC_CHANNELS: ReadonlySet<string> = new Set\(\[/);
  assert.match(source, /ipcChannels\.projectsList/);
  assert.match(source, /ipcChannels\.sessionsCatalogList/);
  assert.match(source, /ipcChannels\.sessionsCatalogReadMessagePage/);
  assert.match(source, /ipcChannels\.filesList/);
  assert.match(source, /ipcChannels\.filesReadContent/);
  assert.match(source, /return NATIVE_READONLY_RPC_CHANNELS\.has\(channel\)/);
  assert.match(source, /: undefined;/);
  assert.doesNotMatch(source, /channel\.startsWith\("sessions:catalog-"\)/);
  assert.doesNotMatch(source, /channel\.startsWith\("files:"\)/);
  assert.doesNotMatch(source, /NATIVE_RPC_TIMEOUT_MS/);
});
