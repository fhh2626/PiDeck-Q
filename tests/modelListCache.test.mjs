import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { normalizePiRpcModels } = loadTsCommonJs("src/shared/piCompatibility.ts");
const pickerHost = readFileSync(
  "src/renderer/src/components/session/ComposerPickerHost.tsx",
  "utf8",
);

test("normalizes TypeScript/Rust RPC model payloads", () => {
  const models = normalizePiRpcModels({
    models: [
      { provider: "anthropic", id: "claude", name: "Claude", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192, reasoning: true },
      { provider: "anthropic", id: "claude", name: "duplicate" },
      { provider: "openai", id: "gpt", images: false },
    ],
  });
  // The transpiled module runs in a VM context; normalize the array/object
  // prototypes before using strict deep equality in the host test context.
  assert.deepEqual(Array.from(models, (model) => ({ ...model })), [
    { provider: "anthropic", id: "claude", name: "Claude", contextWindow: 200000, maxTokens: 8192, reasoning: true, images: true },
    { provider: "openai", id: "gpt", name: "openai/gpt", contextWindow: undefined, maxTokens: undefined, reasoning: undefined, images: false },
  ]);
});

// 缓存命中/强制刷新/空结果重试/配置失效后不被旧结果覆盖：见 modelListCacheBehavior.test.mjs。
// 配置保存触发重取 / spawn 前刷新 / 启动预取 / setModel 的 needsRestart：见 modelListWiring.test.mjs。
// compact 的 customInstructions 字段：见 agentManagerRuntimeCache.test.mjs。

// 以下两条断言渲染层 .tsx 源码：仓库没有 DOM 测试环境（无 jsdom/testing-library），ComposerPickerHost
// 的 JSX 交互无法在 node:test 里真实挂载，因此保留为文本契约，仅作回归栅栏，不证明交互正确。
test("renderer ComposerPickerHost shows restart confirm on needsRestart", () => {
  assert.match(pickerHost, /needsRestart/);
  assert.match(pickerHost, /ConfirmDialog/);
  // 确认后必须走统一重启入口（restartActiveAgent），才能点亮 SessionView overlay；
  // 禁止选择器自己调 restartRuntime（那条路径不置 restartingAgentId）。
  assert.match(pickerHost, /restartActiveAgent/);
  assert.doesNotMatch(pickerHost, /desktopApi\.sessions\.restartRuntime/);
  // 确认时先写会话记录再重启：setRuntimeModel 失败路径不再写 catalog。
  assert.match(pickerHost, /updateRecord\(sessionId, \{[\s\S]*?model: \{ provider: intent\.provider, modelId: intent\.modelId \}/);
  assert.match(pickerHost, /modelRestartTitle/);
  assert.match(pickerHost, /modelRestartBody/);
});

test("ComposerPickerHost loads models on welcome page (no record)", () => {
  // 欢迎页/未启动 Agent 时 record 为 undefined，模型列表也必须加载：
  // useEffect 不再被 `!record` 短路（listModels 是全量的，不依赖 projectId）。
  // 思考级别选择器也需要同一份模型列表（thinkingLevels 支持位）判断是否展示 xhigh/max。
  assert.match(pickerHost, /if \(props\.picker !== "model" && props\.picker !== "thinking"\) return/);
  assert.doesNotMatch(pickerHost, /picker !== "model" \|\| !record/);
  assert.match(pickerHost, /listModels\(record\?\.projectId\)/);
});

test("welcome page model/thinking selection persists; draft defaults come from pi config auto-fill", () => {
  const picker = readFileSync(
    "src/renderer/src/components/session/ComposerPickerHost.tsx",
    "utf8",
  );
  const actions = readFileSync(
    "src/renderer/src/hooks/useSessionActions.ts",
    "utf8",
  );
  const bootstrap = readFileSync(
    "src/renderer/src/utils/chatSessionBootstrap.ts",
    "utf8",
  );
  // 欢迎页（无 record）选模型：仍持久化到 localStorage（显式选择保留）。
  assert.match(picker, /localStorage\.setItem\(WELCOME_MODEL_KEY/);
  assert.match(picker, /localStorage\.setItem\(WELCOME_THINKING_KEY/);
  // createDraft 不再无条件 spread 欢迎页 localStorage 偏好：主进程已按 pi 配置
  // （defaultProvider/defaultModel/defaultThinkingLevel）自动填充默认模型/思考级别。
  assert.doesNotMatch(actions, /readWelcomeModelPreference\(\)|readWelcomeThinkingPreference\(\)/);
  // 共享偏好读取器仅供 ComposerPickerHost 持久化显式选择，不影响 pi 默认值。
  assert.match(bootstrap, /readWelcomeModelPreference/);
  assert.match(bootstrap, /readWelcomeThinkingPreference/);
});
