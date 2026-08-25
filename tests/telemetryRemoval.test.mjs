import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const settingsType = readFileSync("src/shared/types/settings.ts", "utf8");
const settingsStore = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
const mainIndex = readFileSync("src/native-node/index.ts", "utf8");
const settingsModal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("anonymous telemetry settings and heartbeat service are removed", () => {
  assert.doesNotMatch(settingsType, /telemetryEnabled/);
  assert.doesNotMatch(settingsType, /telemetryInstallId/);
  assert.doesNotMatch(settingsType, /telemetryLastHeartbeatDate/);
  assert.doesNotMatch(settingsStore, /telemetryEnabled:\s*true/);
  assert.match(settingsStore, /telemetryEnabled:\s*_ignoredTelemetryEnabled/);
  assert.doesNotMatch(mainIndex, /TelemetryService/);
  assert.doesNotMatch(mainIndex, /POSTHOG/);
  assert.doesNotMatch(mainIndex, /sendTelemetryHeartbeat/);
  assert.equal(existsSync("src/main/telemetry/TelemetryService.ts"), false);
  assert.doesNotMatch(settingsModal, /settings\.telemetry/);
  assert.doesNotMatch(settingsModal, /settings\.privacy/);
  assert.doesNotMatch(zh, /"settings\.telemetry"/);
  assert.doesNotMatch(en, /"settings\.telemetry"/);
});
