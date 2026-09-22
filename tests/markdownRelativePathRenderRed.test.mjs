import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown, defaultRehypePlugins, defaultRemarkPlugins } from "streamdown";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const core = loadTsCommonJs("src/renderer/src/components/session/MarkdownLinkCore.ts");
const notices = [];
const { MarkdownLink } = loadTsCommonJs("src/renderer/src/components/session/MarkdownLink.tsx", {
  stubs: { "../../i18n": { t: (key) => key }, "../../utils/notice": { showNotice: (...args) => notices.push(args) } },
});

function clickRenderedLink(markdown) {
  const opened = [], external = [];
  const anchors = [];
  renderToStaticMarkup(React.createElement(Streamdown, {
    mode: "static", isAnimating: false,
    remarkPlugins: [defaultRemarkPlugins.gfm, defaultRemarkPlugins.codeMeta, core.remarkLinkifyPaths], rehypePlugins: [defaultRehypePlugins.raw], urlTransform: core.markdownUrlTransform,
    components: { a: (props) => {
      const anchor = MarkdownLink({ ...props, onOpenFile: (path) => opened.push(path), onOpenExternal: (url) => external.push(url) });
      anchors.push(anchor);
      return anchor;
    } },
  }, markdown));
  assert.equal(anchors.length, 1, markdown);
  anchors[0].props.onClick({ preventDefault() {}, ctrlKey: false, metaKey: false });
  return { opened, external };
}
for (const path of ["src/项目/图.png", String.raw`src\folder\image.png`, "src/literal%20name.png", "src/image#1.png"]) {
  for (const explicit of [false, true]) {
    test(`Streamdown actual MarkdownLink click preserves ${explicit ? "explicit" : "bare"} ${path}`, () => {
      assert.deepEqual(clickRenderedLink(explicit ? `[image](${path})` : path).opened, [path]);
    });
  }
}
test("Streamdown file URI still validates encoded separators rather than trusting metadata", () => {
  assert.deepEqual(clickRenderedLink("[image](file:///C:/bad%5cname.png)").opened, []);
  assert.ok(notices.length);
  assert.deepEqual(clickRenderedLink("[image](file:///C:/My%20Image.png)").opened, ["C:/My Image.png"]);
  assert.deepEqual(clickRenderedLink("file:///C:/My%20Image.png").opened, ["C:/My Image.png"]);
  assert.deepEqual(clickRenderedLink("file:///C:/bad%2fname.png").opened, []);
});
