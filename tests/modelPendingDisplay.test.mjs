import assert from "node:assert/strict";
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
