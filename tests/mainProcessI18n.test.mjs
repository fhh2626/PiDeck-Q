import assert from "node:assert/strict";
import {  readFileSync } from "node:fs";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  setI18nLocale,
  translateI18nDescriptor,
} = loadTsCommonJs("src/renderer/src/i18n.ts");
const {
  mainProcessT,
  normalizeMainProcessLocale,
} = loadTsCommonJs("src/shared/i18n/mainProcessCopy.ts");

test("main-process copy resolves locale and interpolates stable product text", () => {
  assert.equal(normalizeMainProcessLocale("en-GB"), "en-US");
  assert.equal(normalizeMainProcessLocale("de-DE"), "zh-CN");
  assert.equal(mainProcessT("en-US", "tray.showWindow"), "Show window");
  assert.equal(mainProcessT("en-US", "tray.quit"), "Quit PiDeck-Q");
  assert.equal(
    mainProcessT("en-US", "session.historyTitle", { project: "PiDeck" }),
    "PiDeck history",
  );
  assert.equal(mainProcessT("en-US", "session.imagePlaceholder"), "[Image]");
  assert.equal(
    mainProcessT("zh-CN", "session.importedPreview", { source: "Codex" }),
    "已导入的 Codex 会话",
  );
  assert.equal(
    mainProcessT("en-US", "session.inUseDeleteBlocked", { title: "Review" }),
    'Session "Review" is in use. Close its Agent before deleting it.',
  );
  assert.equal(
    mainProcessT("zh-CN", "wsl.connectionFailed"),
    "无法连接到所选 WSL 发行版和用户，请检查配置后重试。",
  );
  assert.match(
    mainProcessT("en-US", "wsl.piNotInstalled"),
    /@earendil-works\/pi-coding-agent/,
  );
});

test("structured main-process copy translates parameters and preserves fallback behavior", () => {
  setI18nLocale("en-US");
  assert.equal(
    translateI18nDescriptor({
      i18nKey: "diagnostic.commandFailed",
      debugDetails: "stderr payload",
    }, "fallback"),
    "The command failed.",
  );
  assert.equal(
    translateI18nDescriptor({ i18nKey: "missing.key" }, "fallback"),
    "fallback",
  );

  setI18nLocale("zh-CN");
  assert.equal(
    translateI18nDescriptor({
      i18nKey: "diagnostic.requestFailedAfterRetries",
      i18nParams: { attempt: 2, maxAttempts: 3 },
    }, "fallback"),
    "请求失败。\n\n已自动重试：2/3 次",
  );
});

test("diagnostic renderer localizes copy while keeping raw details separate", () => {
  const diagnosticCard = readFileSync(
    "src/renderer/src/components/session/TimelineEventCards.tsx",
    "utf8",
  );
  assert.match(diagnosticCard, /translateI18nDescriptor\(props\.message\.meta, props\.message\.text\)/);
  assert.match(diagnosticCard, /typeof props\.message\.meta\?\.debugDetails === "string"/);
  assert.match(diagnosticCard, /<StackTrace trace=\{stripAnsi\(debugDetails\)\}/);
});

test("Session command failures map stable codes to localized renderer keys", () => {
  const source = readFileSync("src/renderer/src/utils/sessionCommands.ts", "utf8");
  const expected = {
    SESSION_NOT_FOUND: "sessionCommand.sessionNotFound",
    SESSION_RUNTIME_UNAVAILABLE: "sessionCommand.runtimeUnavailable",
    SESSION_RUNTIME_CHANGED: "sessionCommand.runtimeChanged",
    SESSION_RUNTIME_BUSY: "sessionCommand.runtimeBusy",
    SESSION_COMMAND_FAILED: "sessionCommand.commandFailed",
  };
  for (const [code, key] of Object.entries(expected)) {
    assert.match(source, new RegExp(`${code}: "${key.replaceAll(".", "\\.")}"`));
  }
  assert.match(source, /this\.debugDetails = error\.debugDetails/);
  assert.doesNotMatch(source, /super\(error\.debugDetails \|\| error\.code\)/);
});
