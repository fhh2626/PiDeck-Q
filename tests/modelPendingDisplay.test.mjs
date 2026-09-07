import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { computeModelDisplay, formatModelRef } = loadTsCommonJs(
  "src/renderer/src/utils/modelPendingDisplay.ts",
);

function assertDisplay(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test("computeModelDisplay: 无待生效时展示当前模型", () => {
  assertDisplay(
    computeModelDisplay({ provider: "openai", modelId: "gpt-5", modelName: "GPT-5" }, undefined),
    {
      from: { provider: "openai", modelId: "gpt-5", modelName: "GPT-5" },
      pending: false,
    },
  );
});

test("computeModelDisplay: 有待生效时展示 from→to", () => {
  assertDisplay(
    computeModelDisplay(
      { provider: "openai", modelId: "gpt-5" },
      {
        from: { provider: "openai", modelId: "gpt-5", modelName: "GPT-5" },
        to: { provider: "anthropic", modelId: "opus", modelName: "Opus" },
      },
    ),
    {
      from: { provider: "openai", modelId: "gpt-5", modelName: "GPT-5" },
      to: { provider: "anthropic", modelId: "opus", modelName: "Opus" },
      pending: true,
    },
  );
});

test("formatModelRef 带 provider", () => {
  assert.equal(
    formatModelRef({ provider: "grok.weishiair.de copy", modelId: "grok-4.6" }),
    "grok.weishiair.de copy/grok-4.6",
  );
});

test("契约: 生成中可选模型，快照内只记下一轮，新加模型仍重启", () => {
  const area = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
  const components = readFileSync(
    "src/renderer/src/components/session/ComposerComponents.tsx",
    "utf8",
  );
  const picker = readFileSync(
    "src/renderer/src/components/session/ComposerPickerHost.tsx",
    "utf8",
  );
  const hook = readFileSync("src/renderer/src/hooks/usePendingModelApply.ts", "utf8");
  const ipc = readFileSync("src/shared/ipc.ts", "utf8");
  const sessionIpc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
  const preload = readFileSync("src/shared/desktop/createPiDesktopApi.ts", "utf8");

  assert.match(area, /modelDisabled=\{composer\.isStarting\}/);
  assert.match(area, /modelPending=\{modelPendingMap\[props\.sessionId\]\}/);
  assert.match(components, /disabled=\{props\.modelDisabled \?\? props\.disabled\}/);
  assert.match(components, /app\.modelPendingTitle/);

  assert.match(picker, /pickModelWhileBusy/);
  assert.match(picker, /listRuntimeModels\(handle\)/);
  assert.match(picker, /generationInFlight/);
  assert.match(picker, /usePendingModelApply/);
  assert.doesNotMatch(picker, /desktopApi\.sessions\.restartRuntime/);

  // 快照里没有的模型：生成中也走重启确认，不先写 catalog。
  assert.match(
    picker,
    /if \(!snapshotHasModel\) \{\s*offerModelRestart\(handle, model\);\s*return;/,
  );

  // 本轮结束后套到仍活着的 Agent，避免同一会话下一轮仍用旧模型。
  assert.match(hook, /setRuntimeModel/);
  assert.match(hook, /needsRestart/);
  assert.match(hook, /pendingModelRetryDelay/);
  assert.match(hook, /setRetryRevision/);

  assert.match(ipc, /sessionsRuntimeListModels: "sessions:runtime-list-models"/);
  assert.match(sessionIpc, /ipcChannels\.sessionsRuntimeListModels/);
  assert.match(sessionIpc, /listRuntimeModels\(target\)/);
  assert.match(preload, /listRuntimeModels: \(target: SessionRuntimeTarget\)/);
});
