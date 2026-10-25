import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 模型列表实时性 v2（--list-models 加速 + 缓存刷新策略）：
 * 1) parsePiListModels 解析表格输出（provider/model/thinking）
 * 2) MODEL_LIST_FAST_ARGS 包含加速参数（offline/no-ext/skills/themes）
 * 3) fetchModelList 读缓存、refreshModelList 强制重取
 * 4) 接线行为（配置保存重取 / spawn 前刷新 / setModel needsRestart）见 modelListWiring.test.mjs
 */

const {
  parsePiListModels,
  MODEL_LIST_FAST_ARGS,
  MODEL_LIST_RUST_ARGS,
  MODEL_LIST_RPC_ARGS,
} = loadTsCommonJs("src/main/pi/modelListCache.ts");
const { normalizePiRpcModels } = loadTsCommonJs("src/shared/piCompatibility.ts");
const pickerHost = readFileSync(
  "src/renderer/src/components/session/ComposerPickerHost.tsx",
  "utf8",
);

test("parsePiListModels parses table with provider/model/thinking", () => {
  const stdout = [
    "provider  model  context  max-out  thinking  images",
    "openai    gpt-5   200K     64K      yes       yes",
    "deepseek  v4-flash 1M     384K      yes       no",
  ].join("\n");
  const models = parsePiListModels(stdout);
  assert.equal(models.length, 2);
  assert.equal(models[0].provider, "openai");
  assert.equal(models[0].id, "gpt-5");
  assert.equal(models[0].reasoning, true);
  assert.equal(models[1].provider, "deepseek");
  assert.equal(models[1].reasoning, true);
});

test("parsePiListModels keeps provider names containing spaces (regression: grok.weishiair.de copy)", () => {
  // 用户复制 provider 时把名字存成 "grok.weishiair.de copy"（含空格）。旧实现按空格
  // 切分前两列 → provider="grok.weishiair.de"、id="copy"（假模型，真模型 grok-4.6 被吞），
  // 点击假模型报错被分类成「会话已不存在」。修复：从右往左取后 4 列，模型 id 之前的
  // 所有 token 拼回 provider 名。
  const stdout = [
    "provider  model  context  max-out  thinking  images",
    "grok.weishiair.de         grok-4.5                  500K     128K     yes       yes",
    "grok.weishiair.de copy    grok-4.6                  500K     128K     yes       yes",
  ].join("\n");
  const models = parsePiListModels(stdout);
  assert.equal(models.length, 2);
  assert.equal(models[0].provider, "grok.weishiair.de");
  assert.equal(models[0].id, "grok-4.5");
  assert.equal(models[1].provider, "grok.weishiair.de copy");
  assert.equal(models[1].id, "grok-4.6");
  assert.equal(models[1].contextWindow, 500 * 1024);
  assert.equal(models[1].maxTokens, 128 * 1024);
  assert.equal(models[1].reasoning, true);
  assert.equal(models[1].images, true);
});

test("parsePiListModels captures context/maxTokens/images columns", () => {
  const stdout = [
    "provider                  model                         context  max-out  thinking  images",
    "商汤                        deepseek-v4-flash             1M       65.5K    yes       no",
    "智谱                        glm-4v-flash                  128K     4.1K     no        yes",
    "https://open.mwy.asia     gpt-5.6-luna                  272K     128K     yes       yes",
  ].join("\n");
  const models = parsePiListModels(stdout);
  assert.equal(models.length, 3);
  // 中文 provider 与 1M context
  assert.equal(models[0].provider, "商汤");
  assert.equal(models[0].id, "deepseek-v4-flash");
  assert.equal(models[0].contextWindow, 1024 * 1024);
  assert.equal(models[0].maxTokens, Math.round(65.5 * 1024));
  assert.equal(models[0].reasoning, true);
  assert.equal(models[0].images, false);
  // 4.1K max-out 与 images=yes
  assert.equal(models[1].provider, "智谱");
  assert.equal(models[1].id, "glm-4v-flash");
  assert.equal(models[1].contextWindow, 128 * 1024);
  assert.equal(models[1].maxTokens, Math.round(4.1 * 1024));
  assert.equal(models[1].images, true);
  assert.equal(models[1].reasoning, false);
  // URL provider（自定义网关）不受影响
  assert.equal(models[2].provider, "https://open.mwy.asia");
  assert.equal(models[2].id, "gpt-5.6-luna");
  assert.equal(models[2].contextWindow, 272 * 1024);
  assert.equal(models[2].images, true);
});

test("parsePiListModels ignores Rust's trailing Showing note", () => {
  const stdout = [
    "provider  model  context  max-out  thinking  images",
    "openai    gpt-5   200K     64K      yes       yes",
    "Showing 1 of 11 providers. Run `pi --list-providers` to see all.",
  ].join("\n");
  const models = parsePiListModels(stdout);
  assert.equal(models.length, 1);
  assert.equal(models[0].provider, "openai");
});

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

test("parseTokenSize handles M/K/plain and rejects garbage", () => {
  const { parseTokenSize } = loadTsCommonJs("src/main/pi/modelListCache.ts");
  assert.equal(parseTokenSize("1M"), 1024 * 1024);
  assert.equal(parseTokenSize("65.5K"), Math.round(65.5 * 1024));
  assert.equal(parseTokenSize("200K"), 200 * 1024);
  assert.equal(parseTokenSize("4096"), 4096);
  assert.equal(parseTokenSize(""), undefined);
  assert.equal(parseTokenSize("abc"), undefined);
  assert.equal(parseTokenSize("-"), undefined);
});

test("MODEL_LIST_FAST_ARGS includes speed flags", () => {
  assert.ok(MODEL_LIST_FAST_ARGS.includes("--list-models"));
  assert.ok(MODEL_LIST_FAST_ARGS.includes("--offline"));
  assert.ok(MODEL_LIST_FAST_ARGS.includes("--no-extensions"));
  assert.ok(MODEL_LIST_FAST_ARGS.includes("--no-skills"));
  assert.ok(MODEL_LIST_FAST_ARGS.includes("--no-themes"));
});

test("MODEL_LIST_RPC_ARGS uses the neutral RPC mode", () => {
  assert.deepEqual(Array.from(MODEL_LIST_RPC_ARGS.slice(0, 3)), ["--mode", "rpc", "--no-session"]);
});

test("Rust-safe text fallback argument set never includes the unsupported --offline flag", () => {
  // 参数集本身的契约；各偏好实际选用哪一组见 modelListCacheBehavior.test.mjs 的行为测试。
  assert.ok(MODEL_LIST_RUST_ARGS.includes("--list-models"));
  assert.ok(!MODEL_LIST_RUST_ARGS.includes("--offline"));
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
  assert.match(pickerHost, /if \(props\.picker !== "model"\) return/);
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
