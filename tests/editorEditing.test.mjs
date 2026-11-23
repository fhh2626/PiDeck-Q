import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("FileDiffViewer: view mode is editable, diff mode is read-only render", () => {
  const viewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
  // view 模式：CodeMirror 编辑器可编辑（readOnly=false），源码即编辑，无独立编辑按钮
  assert.match(viewer, /<CodeMirrorEditor/);
  assert.match(viewer, /readOnly=\{false\}/);
  // diff 模式：只读差异对比视图（CodeDiffView），不再有编辑态切换/编辑按钮
  assert.match(viewer, /<CodeDiffView/);
  assert.doesNotMatch(viewer, /Edit3/);
  assert.doesNotMatch(viewer, /PencilOff/);
  assert.doesNotMatch(viewer, /setReadOnly/);
  // markdown/html/svg 打开默认预览模式，点「源码」切换才进入编辑态；tab 切换同样重置为默认预览
  assert.match(viewer, /const defaultPreview = !isDiffMode && \(isMarkdown \|\| isHtml \|\| isSvg\)/);
  assert.match(viewer, /useState\(defaultPreview\)/);
  assert.match(viewer, /setPreview\(defaultPreview\)/);
});

test("FileDiffViewer: debounced auto-save with Ctrl+S immediate save", () => {
  const viewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8")
    + readFileSync("src/renderer/src/hooks/useFileEditorBuffer.ts", "utf8")
    + readFileSync("src/renderer/src/atoms/file-editor-saves.ts", "utf8");
  // 自动保存：编辑停止 500ms 后落盘（saveContent 存在时）；内容未变跳过
  assert.match(viewer, /scheduleAutoSave/);
  assert.match(viewer, /setTimeout\(\(\) => \{\n\s*saveTimerRef\.current = null;/);
  assert.match(viewer, /500\);/);
  assert.match(viewer, /const savedDocument = lastSavedRef\.current/);
  assert.match(viewer, /if \(input\.content !== previousContent\) await input\.saveContent/);
  // 加载完成即建立「已落盘」基准，避免打开后无改动就写盘
  assert.match(viewer, /lastSavedRef\.current = \{\s*content: result/);
  // Ctrl+S 立即保存（取消挂起 timer），卸载清理 timer（生命周期配对）
  assert.match(viewer, /void saveNow\(\);/);
  assert.match(viewer, /clearTimeout\(saveTimerRef\.current\)/);
});

test("editors bind Ctrl+/ comment toggle and JSON lint", () => {
  const editor = readFileSync("src/renderer/src/components/app/CodeMirrorEditor.tsx", "utf8");
  // Ctrl+/ 注释/取消注释（@codemirror/commands 的 toggleComment）
  assert.match(editor, /import \{[^}]*toggleComment/);
  assert.match(editor, /Mod-\//);
  // JSON 语法错误即时提示（lintGutter + jsonParseLinter，仅 json/jsonc）。
  // 异步 loader 后 jsonParseLinter 单独 import 成 linter 扩展（jsonLinter 变量），
  // 再与 lintGutter 一起装入 JSON 分支；两者分属不同行，断言各自存在即可。
  assert.match(editor, /linter\(jsonParseLinter\(\)\)/);
  assert.match(editor, /lintGutter\(\),\s*jsonLinter/);
  assert.match(editor, /resolvedLanguage\.language\.name === "json"/);
});

test("FileDiffViewer: markdown preview reuses .markdown-body + markdown-preview-chrome, no parallel legacy classes", () => {
  const viewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
  const surfaces = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");
  const tailwind = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");
  // 预览容器挂 markdown-body（与会话正文同一排版体系）+ markdown-preview-chrome（预览增量）
  assert.match(viewer, /markdown-body markdown-preview-chrome/);
  // 预览专属增量注册在 tailwind.css 的 @utility（新架构），不允许回落到 legacy surfaces.css 手写类
  assert.match(tailwind, /@utility markdown-preview-chrome/);
  assert.doesNotMatch(surfaces, /\.file-diff-preview/);
  // HTML 预览 iframe 改用 Tailwind 类，不再依赖 legacy 类
  assert.doesNotMatch(viewer, /className="file-diff-preview"/);
});

test("FileDiffViewer: SVG preview via content data URL, media fills the pane", () => {
  const viewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
  const css = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");
  // SVG 是文本（可编辑），预览按钮与 md/html 同待遇；预览渲染为 data URL 图片
  assert.match(viewer, /const isSvg = ext === "svg"/);
  assert.match(viewer, /\(isMarkdown \|\| isHtml \|\| isSvg\) && !isDiffMode/);
  assert.match(viewer, /data:image\/svg\+xml;charset=utf-8/);
  assert.match(viewer, /encodeURIComponent\(content\)/);
  // 图片占满预览区：width/height 100% + contain（小图放大、大图缩小、不变形）
  assert.match(css, /\.file-diff-media-preview img \{\n\s*\/\* 占满预览区/);
  assert.match(css, /width: 100%;\n\s*height: 100%;\n\s*object-fit: contain;/);
});
