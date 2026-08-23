import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";

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

test("editorTheme is a valid theme extension without legacy merge classes", () => {
  const { editorTheme } = loadModule();
  // editorTheme 是合法主题扩展（theme() 构建不抛 Unsupported selector）
  assert.ok(editorTheme);
  const src = readFileSync("src/renderer/src/utils/codemirrorSetup.ts", "utf8");
  // diff 渲染已迁移到独立渲染库（CodeDiffView），编辑器主题不再残留 merge 类名
  assert.doesNotMatch(src, /cm-merge-pane/);
  assert.doesNotMatch(src, /cm-merge-gap/);
  assert.doesNotMatch(src, /cm-merge-chunk/);
  assert.doesNotMatch(src, /cm-merge-collapsed/);
  assert.doesNotMatch(src, /cm-collapsedLines/);
  // theme() 不支持 &light/&dark 选择器（仅 baseTheme 支持），出现会抛 "Unsupported selector"
  assert.doesNotMatch(src, /"&light|"&dark/);
});

test("language packages are loaded on demand, not statically imported", () => {
  // 性能优化核心：codemirrorSetup 不再静态 import @codemirror/lang-* 与 legacy-modes，
  // 只静态 import core（language/state/view/lezer）。语言包通过 loadEditorLanguage
  // 内的动态 import() 按需拉入，用户只聊天时 parser 不进初始模块图。
  const src = readFileSync("src/renderer/src/utils/codemirrorSetup.ts", "utf8");
  // 静态 import 区（文件顶部到 loadEditorLanguage 之前）不应再有 lang-* / legacy-modes
  const head = src.slice(0, src.indexOf("async function actuallyLoadLanguage"));
  assert.doesNotMatch(head, /import \{[^}]*\} from "@codemirror\/lang-/);
  assert.doesNotMatch(head, /from "@codemirror\/legacy-modes\//);
  // 动态 import 仍在（按需）
  assert.match(src, /await import\("@codemirror\/lang-javascript"\)/);
  assert.match(src, /await import\("@codemirror\/legacy-modes\/mode\/shell"\)/);
});
