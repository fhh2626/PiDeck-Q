import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, imports = {}) {
  const source = readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => imports[specifier] ?? nodeRequire(specifier);
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
  }, { filename: filePath });
  return module.exports;
}

const { resolveResendModelSelection } = compileModule(
  "src/renderer/src/utils/resendModelSelection.ts",
);

test("resend model selection: pending model wins over runtime and record", () => {
  const selection = resolveResendModelSelection({
    pending: {
      from: { provider: "anthropic", modelId: "claude", modelName: "Claude" },
      to: { provider: "deepseek", modelId: "deepseek-chat", modelName: "DeepSeek" },
    },
    runtimeState: { provider: "openai", modelId: "gpt-5", thinkingLevel: "low" },
    recordModel: { provider: "google", modelId: "gemini" },
    recordThinkingLevel: "high",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(selection)), {
    model: { provider: "deepseek", modelId: "deepseek-chat" },
  });
});

test("resend model selection: live runtime state beats a stale catalog record (/model rotation)", () => {
  const selection = resolveResendModelSelection({
    runtimeState: { provider: "openai", modelId: "gpt-5", thinkingLevel: "medium" },
    recordModel: { provider: "anthropic", modelId: "claude" },
    recordThinkingLevel: "high",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(selection)), {
    model: { provider: "openai", modelId: "gpt-5" },
    thinkingLevel: "medium",
  });
});

test("resend model selection: falls back to the record when no runtime state is available", () => {
  const selection = resolveResendModelSelection({
    recordModel: { provider: "anthropic", modelId: "claude" },
    recordThinkingLevel: "high",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(selection)), {
    model: { provider: "anthropic", modelId: "claude" },
    thinkingLevel: "high",
  });
});

test("resend model selection: an incomplete pending/runtime/record entry is skipped, not half-applied", () => {
  assert.equal(
    resolveResendModelSelection({
      pending: { from: { provider: "", modelId: "" }, to: { provider: "deepseek", modelId: "" } },
      runtimeState: { provider: "openai" },
      recordModel: { provider: "", modelId: "" },
    }),
    undefined,
  );
});

test("resend model selection: returns undefined so the backend keeps the catalog preference", () => {
  assert.equal(resolveResendModelSelection({}), undefined);
  assert.equal(
    resolveResendModelSelection({ runtimeState: { isStreaming: false } }),
    undefined,
  );
});
