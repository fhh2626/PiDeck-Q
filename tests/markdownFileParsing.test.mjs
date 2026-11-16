import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { remarkLinkifyPaths } from "../src/renderer/src/components/session/MarkdownLinkCore.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createHookHarness, flush } from "./helpers/imagePreviewHarness.mjs";

const parser = unified().use(remarkParse).use(remarkLinkifyPaths).use(remarkRehype);
function elements(markdown, tagName) {
  const matches = [];
  const visit = (node) => {
    if (node.type === "element" && node.tagName === tagName) matches.push(node);
    node.children?.forEach(visit);
  };
  visit(parser.runSync(parser.parse(markdown)));
  return matches;
}

for (const source of ["images/a b.png", "图片/图一.png", "images/literal%20.png"]) {
  for (const linked of [false, true]) {
    test(`Markdown parsing preserves the real ${linked ? "linked" : "standalone"} image path ${source}`, () => {
      const image = `![thumbnail](<${source}>)`;
      const markdown = linked ? `[${image}](guide.md)` : image;
      const [img] = elements(markdown, "img");
      assert.ok(img);
      assert.equal(img.properties["data-local-path"], source);
      assert.equal(elements(markdown, "a").length, linked ? 1 : 0,
        "the image does not create a nested link");
    });
  }
}

test("images nested in formatted link labels retain their original destinations", () => {
  const [img] = elements("[**![thumbnail](<images/a b.png>)** src/a.ts](guide.md)", "img");
  assert.equal(img.properties["data-local-path"], "images/a b.png");
  assert.equal(elements("[**![thumbnail](<images/a b.png>)** src/a.ts](guide.md)", "a").length, 1,
    "ordinary paths in an existing link label are never linkified again");
});

test("reference images and links preserve local definition paths before URL encoding", () => {
  const markdown = "[![thumbnail][image]][document]\n\n[image]: <images/a b%20.png>\n[document]: <docs/指南 one.md>";
  assert.equal(elements(markdown, "img")[0].properties["data-local-path"], "images/a b%20.png");
  assert.equal(elements(markdown, "a")[0].properties["data-local-path"], "docs/指南 one.md");
});

for (const markdown of [
  "[guide](<docs/my guide%20.md#section>)",
  "[guide][doc]\n\n[doc]: <docs/my guide%20.md#section>",
  "[guide](<docs/my guide%20.md?raw=1#section>)",
  "[guide][doc]\n\n[doc]: <docs/my guide%20.md?raw=1>",
]) {
  test(`a Markdown document URL opens its file without changing literal percent signs: ${markdown.split("\n")[0]}`, () => {
    const [anchor] = elements(markdown, "a");
    const { MarkdownLink } = loadTsCommonJs(resolve("src/renderer/src/components/session/MarkdownLink.tsx"), {
      stubs: { "../../i18n": { t: (key) => key }, "../../utils/notice": { showNotice: () => undefined } },
      globals: { navigator: { userAgent: "Windows NT 10.0" } },
    });
    const opened = [];
    const link = MarkdownLink({
      ...anchor.properties, basePath: "C:/repo", onOpenFile: (path) => opened.push(path),
      onOpenExternal: () => assert.fail("a document fragment is a local file target"),
    });
    link.props.onClick({ preventDefault() {} });
    assert.deepEqual(opened, ["C:/repo/docs/my guide%20.md"]);
  });
}

test("a local SVG image fragment is separated before the authorized file read", async () => {
  const [image] = elements("![diagram](images/diagram.svg#view)", "img");
  const harness = createHookHarness();
  const reads = [];
  const { MarkdownImage } = loadTsCommonJs(resolve("src/renderer/src/components/session/MarkdownImage.tsx"), {
    stubs: {
      react: harness.react,
      "../../desktopApi": { desktopApi: { files: { readBase64: async (path) => { reads.push(path); return "PHN2Zy8+"; } } } },
      "../../i18n": { t: (key) => key },
    },
    globals: { navigator: { userAgent: "Windows NT 10.0" } },
  });
  try {
    const props = { ...image.properties, basePath: "C:/repo" };
    harness.render(() => MarkdownImage(props));
    await flush();
    assert.deepEqual(reads, ["C:/repo/images/diagram.svg"]);
    assert.equal(harness.render(() => MarkdownImage(props)).props.src, "data:image/svg+xml;base64,PHN2Zy8+");
  } finally {
    harness.unmount();
  }
});

test("a Markdown image query is excluded from its authorized read and click target", async () => {
  const [image] = elements("![diagram](<images/图 one%20.png?raw=1#view>)", "img");
  const harness = createHookHarness();
  const reads = [];
  const opened = [];
  const { MarkdownImage } = loadTsCommonJs(resolve("src/renderer/src/components/session/MarkdownImage.tsx"), {
    stubs: {
      react: harness.react,
      "../../desktopApi": { desktopApi: { files: { readBase64: async (path) => { reads.push(path); return "aGVsbG8="; } } } },
      "../../i18n": { t: (key) => key },
    },
    globals: { navigator: { userAgent: "Windows NT 10.0" } },
  });
  try {
    const props = { ...image.properties, basePath: "C:/repo", onOpenFile: (path) => opened.push(path) };
    harness.render(() => MarkdownImage(props));
    await flush();
    const loadedImage = harness.render(() => MarkdownImage(props));
    loadedImage.props.onClick({ currentTarget: { closest: () => null }, preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(reads, ["C:/repo/images/图 one%20.png"]);
    assert.deepEqual(opened, reads);
  } finally {
    harness.unmount();
  }
});

test("auto-linked disk paths keep literal hashes and file URLs keep their validated decoder", () => {
  const [raw] = elements("docs/report#1.md", "a");
  assert.equal(raw.properties["data-local-path"], "docs/report#1.md");
  const [uri] = elements("[report](file:///C:/repo/report%231.md#section)", "a");
  assert.equal(uri.properties["data-local-path"], undefined);
  assert.equal(uri.properties.href, "file:///C:/repo/report%231.md#section");
});
