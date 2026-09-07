import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  "src/renderer/src/components/app/FileDiffViewer.tsx",
  "utf8",
);

test("HTML files have an in-place preview without widening renderer access", () => {
  assert.match(source, /const isHtml = ext === "html" \|\| ext === "htm"/);
  assert.match(source, /\(isMarkdown \|\| isHtml \|\| isSvg\) && !isDiffMode/);
  assert.match(source, /<HtmlPreview content=\{content\} \/>/);
});

test("HTML preview remains isolated from the renderer origin and popup capability", () => {
  const start = source.indexOf("function HtmlPreview(");
  assert.ok(start >= 0, "HtmlPreview should be defined");
  const preview = source.slice(start);
  assert.match(preview, /srcDoc=\{content\}/);
  assert.match(preview, /sandbox="allow-scripts allow-forms"/);
  assert.match(preview, /referrerPolicy="no-referrer"/);
  assert.doesNotMatch(preview, /allow-same-origin|allow-popups|allow-top-navigation/);
});
