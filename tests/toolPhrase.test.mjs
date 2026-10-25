import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 工具语义短语（学 Proma tool-phrase.ts）：折叠态显示可读中文短语，
// 替代完整命令行，让工具行更轻、更易扫读。
// 通过真实模块图加载（含真实 parseToolArgs），不再对源码文本做 import 剥离/替换。
const { getToolPhrase, getToolPhraseFromArgs } = loadTsCommonJs(
  "src/renderer/src/components/session/timeline/toolPhrase.ts",
);

function loadPhrase(toolName, input) {
  return getToolPhrase(toolName, input);
}

test("tool arguments given as a JSON string are parsed before building the phrase", () => {
  const phrase = getToolPhraseFromArgs("Read", JSON.stringify({ file_path: "src/deep/main.ts" }));
  assert.match(phrase.label, /读取 main\.ts/);
});
test("read tool produces a readable file phrase", () => {
  const phrase = loadPhrase("Read", { file_path: "src/main.ts" });
  assert.match(phrase.label, /读取 main\.ts/);
  assert.match(phrase.loadingLabel, /正在读取 main\.ts/);
});

test("bash tool shows the command", () => {
  const phrase = loadPhrase("Bash", { command: "npm run build" });
  assert.match(phrase.label, /执行 npm run build/);
  assert.match(phrase.loadingLabel, /正在执行 npm run build/);
});

test("grep tool shows the pattern", () => {
  const phrase = loadPhrase("Grep", { pattern: "TODO" });
  assert.match(phrase.label, /搜索 TODO/);
});

test("web_search tool uses a search phrase rather than a fetch phrase", () => {
  const phrase = loadPhrase("web_search", { query: "OpenAI Responses API" });
  assert.match(phrase.label, /搜索 OpenAI Responses API/);
  assert.match(phrase.loadingLabel, /正在搜索 OpenAI Responses API/);
});

test("write tool produces file phrase", () => {
  const phrase = loadPhrase("Write", { file_path: "a/b/new.ts" });
  assert.match(phrase.label, /写入 new\.ts/);
});

test("unknown/extension tool falls back to name + arg summary", () => {
  const phrase = loadPhrase("get_search_content", { query: "shadcn" });
  assert.match(phrase.label, /get_search_content shadcn/);
});
