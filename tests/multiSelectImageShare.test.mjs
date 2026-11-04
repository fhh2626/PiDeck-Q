import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";
import ts from "typescript";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import vm from "node:vm";

test("html-to-image stays behind the shared dynamic loader", () => {
  for (const relativePath of readdirSync("src/renderer/src", { recursive: true })) {
    if (typeof relativePath !== "string" || !/\.[cm]?[jt]sx?$/.test(relativePath)) continue;
    const source = readFileSync(`src/renderer/src/${relativePath}`, "utf8");
    const sourceFile = ts.createSourceFile(
      relativePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      relativePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const runtimeImport = sourceFile.statements.find((statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "html-to-image" &&
      !statement.importClause?.isTypeOnly
    );
    // 静态架构规则：任何渲染层文件都不得静态 import html-to-image（必须经动态加载器），用 AST 检查 import 声明是正确工具。
    assert.equal(
      runtimeImport,
      undefined,
      `${relativePath} must not statically import html-to-image`,
    );
  }

});

test("html-to-image loader imports the library lazily, shares one request and retries after a failure", async () => {
  // 行为校验（原先是对 import("html-to-image") 文本的正则）：
  // 模块加载时不得触碰库；首次调用才加载；并发复用同一请求；失败后清缓存可重试。
  let requires = 0;
  let failNext = true;
  const library = { toPng: () => "png" };
  const stubs = {};
  Object.defineProperty(stubs, "html-to-image", {
    enumerable: true,
    get() {
      requires += 1;
      if (failNext) {
        failNext = false;
        throw new Error("transient chunk error");
      }
      return library;
    },
  });
  const { loadHtmlToImage } = loadTsCommonJs("src/renderer/src/utils/htmlToImage.ts", { stubs });
  assert.equal(requires, 0, "importing the loader module must not load html-to-image");

  await assert.rejects(loadHtmlToImage(), /transient chunk error/);
  const first = loadHtmlToImage();
  const second = loadHtmlToImage();
  assert.strictEqual(first, second, "concurrent callers share one request");
  assert.equal((await first).toPng(), "png");
  assert.strictEqual(loadHtmlToImage(), first, "successful load stays cached");
  assert.equal(requires, 2, "one failed attempt plus one successful attempt");
});

function loadAppUtils() {
  const source = readFileSync("src/renderer/src/components/app/AppUtils.ts", "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  // AppUtils 引用 session/composer/chips；vm 沙箱不会解析相对模块，显式桩掉。
  const sandbox = {
    exports: {},
    location: { href: "file:///Users/test/app" },
    require: (id) => {
			if (id === "../session/composer/chips") return { formatFilePathRef: (p) => p };
      return {};
    },
  };
  vm.runInNewContext(outputText, sandbox, { filename: "AppUtils.ts" });
  return sandbox.exports;
}

test("multi-select image export stays renderable for html-to-image", () => {
  // 文本匹配在此是正确工具：这是 CSS 规则内容契约（无浏览器布局引擎可验证，linkedom 不计算样式）。
  const styles = readRendererStyles();
  const rule = styles.match(/\.multi-select-image-export \{([\s\S]*?)\n\}/)?.[1] ?? "";

  assert.match(rule, /left:\s*0;/);
  assert.doesNotMatch(rule, /-100000px/);
});

test("multi-select image export maps selected assistant messages to their visible run rows", () => {
  const { getMultiSelectImageCaptureIds } = loadAppUtils();
  const user = { kind: "message", message: { id: "u1", role: "user", text: "hi", timestamp: 1 } };
  const run = {
    kind: "agent-run",
    id: "run-1",
    startedAt: 2,
    endedAt: 3,
    items: [
      { kind: "message", message: { id: "a1", role: "assistant", text: "first", timestamp: 2 } },
      { kind: "message", message: { id: "a2", role: "assistant", text: "second", timestamp: 3 } },
    ],
  };

  const ids = getMultiSelectImageCaptureIds([user, run], new Set(["u1", "a2"]));

  assert.deepEqual([...ids], ["u1", "run-1"]);
});
