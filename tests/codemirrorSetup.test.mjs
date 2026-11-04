import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);

// codemirrorSetup.ts 是 ESM 源码，先 transpile 为 CommonJS 再 require 执行。
// Node 24 支持 require(esm)，@codemirror/* 的真实实现可被加载（纯 JS，无 DOM 依赖）。
// 语言包改为按需动态 import 后，transpile 到 CommonJS 时 import() 变为
// Promise.resolve().then(() => require(...))，因此 loadEditorLanguage 是异步的，
// 测试需 await。
function loadModule() {
  const output = ts.transpileModule(
    readFileSync("src/renderer/src/utils/codemirrorSetup.ts", "utf8"),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: "codemirrorSetup.ts",
    },
  ).outputText;
  const tmpFile = `${process.cwd()}/tests/.tmp-codemirrorSetup-${Date.now()}.cjs`;
  const { writeFileSync, rmSync } = require("node:fs");
  writeFileSync(tmpFile, output);
  try {
    return require(tmpFile);
  } finally {
    rmSync(tmpFile, { force: true });
  }
}

test("loadEditorLanguage maps common extensions to language packages", async () => {
  const { loadEditorLanguage } = loadModule();
  // 常用扩展名应有语言包（LanguageSupport.language.name 为解析器名）
  for (const ext of ["ts", "jsx", "json", "md", "css", "scss", "less", "html", "yaml", "py", "go", "rs", "java", "cpp", "sql"]) {
    const lang = await loadEditorLanguage(ext);
    assert.ok(lang, `extension ${ext} should resolve to a language`);
  }
  // legacy-modes 冷门语言（StreamLanguage 包装，language.name 存在）
  assert.ok(await loadEditorLanguage("sh"));
  assert.ok(await loadEditorLanguage("toml"));
  assert.ok(await loadEditorLanguage("dockerfile"));
  assert.ok(await loadEditorLanguage("rb"));
});

test("loadEditorLanguage accepts legacy Monaco language ids", async () => {
  const { loadEditorLanguage } = loadModule();
  // 旧调用点传 Monaco id（如 FileDiffViewer 旧代码的 "markdown"/"typescript"）
  assert.ok(await loadEditorLanguage("markdown"));
  assert.ok(await loadEditorLanguage("typescript"));
  assert.ok((await loadEditorLanguage("plaintext")) === null);
});

test("loadEditorLanguage falls back to plaintext for unknown/cold languages", async () => {
  const { loadEditorLanguage } = loadModule();
  // 无官方包的冷门类型明确降级纯文本（null），不允许抛错
  assert.equal(await loadEditorLanguage("graphql"), null);
  assert.equal(await loadEditorLanguage("makefile"), null);
  assert.equal(await loadEditorLanguage("unknown-ext"), null);
  assert.equal(await loadEditorLanguage(""), null);
  assert.equal(await loadEditorLanguage(undefined), null);
});

test("loadEditorLanguage caches by normalized key (Promise cache)", async () => {
  const { loadEditorLanguage } = loadModule();
  // 同一 key 并发多次返回同一 Promise 实例（Promise cache 生效），
  // 避免同时打开多个同语言文件重复 import / 创建 parser。
  const a = loadEditorLanguage("ts");
  const b = loadEditorLanguage("ts");
  assert.equal(a, b, "same key should return the same cached Promise");
  const c = loadEditorLanguage("  TS ");
  assert.equal(a, c, "normalized (trim + lowercase) key should hit the same cache");
  await a;
});

test("baseEditorExtensions applies readOnly and wordWrap", async () => {
  const { baseEditorExtensions, loadEditorLanguage } = loadModule();
  // readOnly 只追加 EditorState.readOnly 一个扩展：不设 editable.of(false)，
  // 否则 contenteditable 被移除后双击选词/三击选行/拖拽选块全部失效（只读仍要能选中）
  const readOnly = baseEditorExtensions({ readOnly: true });
  assert.equal(readOnly.length, baseEditorExtensions().length + 1);
  // wordWrap 追加 lineWrapping 一个扩展
  const wrapped = baseEditorExtensions({ wordWrap: true });
  assert.equal(wrapped.length, baseEditorExtensions().length + 1);
  // language 追加一个扩展
  const withLang = baseEditorExtensions({ language: await loadEditorLanguage("md") });
  assert.equal(withLang.length, baseEditorExtensions().length + 1);
  // 组合叠加
  const all = baseEditorExtensions({ readOnly: true, wordWrap: true, language: await loadEditorLanguage("md") });
  assert.equal(all.length, baseEditorExtensions().length + 3);
});

test("editorTheme is a valid theme extension", () => {
  const { editorTheme } = loadModule();
  // editorTheme 是合法主题扩展：theme() 在模块加载时就会构建 StyleModule，
  // 若主题里出现 theme() 不支持的 &light/&dark 选择器会抛 "Unsupported selector"，
  // 加载（loadModule）本身即覆盖该约束。
  assert.ok(editorTheme);
  // 主题能被真实 EditorState 安装（扩展树合法）
  const { EditorState } = require("@codemirror/state");
  const { baseEditorExtensions } = loadModule();
  assert.doesNotThrow(() => EditorState.create({ doc: "x", extensions: baseEditorExtensions() }));
});

test("editor theme source has no legacy merge-view classes", () => {
  // 文本匹配合理：这是“已移除功能不得回归”的静态规则（diff 渲染已迁到 CodeDiffView），
  // 主题里残留的 cm-merge-* 类名没有任何运行时入口可断言。
  const src = readFileSync("src/renderer/src/utils/codemirrorSetup.ts", "utf8");
  assert.doesNotMatch(src, /cm-merge-pane/);
  assert.doesNotMatch(src, /cm-merge-gap/);
  assert.doesNotMatch(src, /cm-merge-chunk/);
  assert.doesNotMatch(src, /cm-merge-collapsed/);
  assert.doesNotMatch(src, /cm-collapsedLines/);
});

test("readOnly editors set the readOnly state without disabling the editable facet", () => {
  const { baseEditorExtensions } = loadModule();
  const { EditorState } = require("@codemirror/state");
  const { EditorView } = require("@codemirror/view");
  const state = EditorState.create({ doc: "hello", extensions: baseEditorExtensions({ readOnly: true }) });
  // readOnly 在状态层生效（命令层据此拒绝编辑）……
  assert.equal(state.readOnly, true);
  // ……但不得设置 editable=false，否则 contenteditable 被移除，双击选词/拖拽选块全部失效
  assert.equal(state.facet(EditorView.editable), true);
  // 默认（非只读）编辑器 readOnly 为 false
  assert.equal(EditorState.create({ doc: "hello", extensions: baseEditorExtensions() }).readOnly, false);
});

test("wordWrap installs line wrapping on the content element", () => {
  const { baseEditorExtensions } = loadModule();
  const { EditorState } = require("@codemirror/state");
  const { EditorView } = require("@codemirror/view");
  const classes = (state) =>
    state.facet(EditorView.contentAttributes).map((attrs) => attrs.class ?? "").join(" ");
  const wrapped = EditorState.create({ extensions: baseEditorExtensions({ wordWrap: true }) });
  const plain = EditorState.create({ extensions: baseEditorExtensions() });
  assert.match(classes(wrapped), /cm-lineWrapping/);
  assert.doesNotMatch(classes(plain), /cm-lineWrapping/);
});

// 语言包按需加载：以“require 记录”观察模块图，而不是 grep import 语句。
const LAZY_PACKAGES = [
  "@codemirror/lang-javascript",
  "@codemirror/lang-json",
  "@codemirror/lang-markdown",
  "@codemirror/lang-css",
  "@codemirror/lang-sass",
  "@codemirror/lang-less",
  "@codemirror/lang-html",
  "@codemirror/lang-yaml",
  "@codemirror/lang-xml",
  "@codemirror/lang-python",
  "@codemirror/lang-go",
  "@codemirror/lang-rust",
  "@codemirror/lang-java",
  "@codemirror/lang-cpp",
  "@codemirror/lang-sql",
  "@codemirror/legacy-modes/mode/shell",
];

/** getter 型替身：每次被 require 解析时记一笔，可配置为首次失败。 */
function createRecordingStubs({ failFirst = new Set() } = {}) {
  const requested = [];
  const failed = new Set();
  const stubs = {};
  for (const name of LAZY_PACKAGES) {
    Object.defineProperty(stubs, name, {
      enumerable: true,
      get() {
        requested.push(name);
        if (failFirst.has(name) && !failed.has(name)) {
          failed.add(name);
          throw new Error(`simulated chunk load failure: ${name}`);
        }
        return {
          javascript: (options) => ({ lang: "javascript", options }),
          shell: { name: "shell-mode" },
        };
      },
    });
  }
  return { stubs, requested };
}

test("language packages are loaded on demand, not when the module is imported", async () => {
  const { stubs, requested } = createRecordingStubs();
  const mod = loadTsCommonJs("src/renderer/src/utils/codemirrorSetup.ts", { stubs });
  // 导入模块（含构建主题/高亮）不得拉入任何 lang-* / legacy-modes：用户只聊天时 parser 不进初始模块图
  assert.equal(requested.length, 0);

  const ts = await mod.loadEditorLanguage("ts");
  assert.equal(JSON.stringify(ts), JSON.stringify({ lang: "javascript", options: { typescript: true } }));
  // 只拉入被请求语言对应的那一个包
  assert.equal(requested.join(","), "@codemirror/lang-javascript");

  assert.ok(await mod.loadEditorLanguage("sh"));
  assert.equal(requested.join(","), "@codemirror/lang-javascript,@codemirror/legacy-modes/mode/shell");
});

test("a failed language import is not cached, so the next request retries", async () => {
  const { stubs, requested } = createRecordingStubs({
    failFirst: new Set(["@codemirror/lang-javascript"]),
  });
  const mod = loadTsCommonJs("src/renderer/src/utils/codemirrorSetup.ts", { stubs });
  await assert.rejects(mod.loadEditorLanguage("js"), /simulated chunk load failure/);
  const retried = await mod.loadEditorLanguage("js");
  assert.equal(retried.lang, "javascript");
  assert.equal(requested.length, 2, "失败后必须重新 import，而不是永久卡在失败态");
});