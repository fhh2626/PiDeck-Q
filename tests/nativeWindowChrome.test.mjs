import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveNativeWindowChrome } from "../src/renderer/src/native/nativeWindowChrome.ts";

test("native macOS keeps system window decorations and resizing", () => {
  assert.deepEqual(resolveNativeWindowChrome(false, "darwin", true), {
    useNativeTitleBar: true,
    enableCustomResize: false,
  });
});

test("native Windows and Linux may use renderer resize handles", () => {
  for (const platform of ["win32", "linux"]) {
    assert.deepEqual(resolveNativeWindowChrome(false, platform, true), {
      useNativeTitleBar: false,
      enableCustomResize: true,
    });
  }
});

test("requested native titlebars disable custom resize on every platform", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    assert.deepEqual(resolveNativeWindowChrome(true, platform, true), {
      useNativeTitleBar: true,
      enableCustomResize: false,
    });
  }
});

test("non-native runtimes do not receive Qt resize handles", () => {
  assert.deepEqual(resolveNativeWindowChrome(false, "linux", false), {
    useNativeTitleBar: false,
    enableCustomResize: false,
  });
});

test("custom titlebar system-move RPC is reserved for native frameless hosts", () => {
  const shell = readFileSync(new URL("../src/renderer/src/components/app/AppShell.tsx", import.meta.url), "utf8");
  assert.match(shell, /if \(useNativeTitleBar \|\| !enableNativeResize\) return/);
});
