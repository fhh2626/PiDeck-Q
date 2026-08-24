import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  "src/renderer/src/hooks/useGlobalAgentListeners.ts",
  "utf8",
);
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const bootstrap = readFileSync(
  "src/renderer/src/components/app/AppBootstrap.tsx",
  "utf8",
);
const runtimeBridge = readFileSync(
  "src/renderer/src/hooks/useSessionRuntimeBridge.ts",
  "utf8",
);

test("global listener owner handles non-runtime application events only", () => {
  for (const listener of [
    "projects.onChanged",
		"app.onFocusSessionTarget",
    "projects.onTrustRequest",
    "settings.onApplyWindow",
    "app.onUpdateProgress",
  ]) {
    assert.match(source, new RegExp(listener.replace(".", "\\.")), listener);
  }
  assert.doesNotMatch(source, /sessions\.(?:listRuntimes|onRuntimeEvent)/);
  assert.match(source, /return \(\) => \{[\s\S]*offProjects\(\)[\s\S]*offFocusTarget\(\)/);
  assert.match(source, /disposed = true/);
});

test("Session runtime bridge is the sole runtime event and inventory owner", () => {
  assert.match(runtimeBridge, /sessions\.listRuntimes\(\)/);
  assert.match(runtimeBridge, /replaceSessionRuntimesAtom/);
  assert.match(runtimeBridge, /sessions\.onRuntimeEvent\(/);
  assert.match(runtimeBridge, /applySessionRuntimeEventAtom/);
  assert.doesNotMatch(source, /replaceAgentInventoryAtom|applyRuntimeCapabilityAtom/);
});

test("global listener owner explicitly excludes Session message, thinking, and UI request streams", () => {
  assert.doesNotMatch(source, /\.onMessages\(/);
  assert.doesNotMatch(source, /\.onThinking\(/);
  assert.doesNotMatch(source, /\.onUiRequest\(/);
  assert.doesNotMatch(source, /desktopApi\.agents\./);
  assert.doesNotMatch(app, /api\.agents\.(?:onMessages|onThinking|onUiRequest)\(/);
  assert.match(bootstrap, /useGlobalAgentListeners\(/);
});
