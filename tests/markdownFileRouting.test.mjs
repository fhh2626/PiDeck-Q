import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { atom, createStore } from "jotai";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createHookHarness, flush, nodes } from "./helpers/imagePreviewHarness.mjs";

const i18n = { t: (key) => key };
const notices = { showNotice: () => undefined };
const { MarkdownLink } = loadTsCommonJs(resolve("src/renderer/src/components/session/MarkdownLink.tsx"), {
  stubs: { "../../i18n": i18n, "../../utils/notice": notices },
  globals: { navigator: { userAgent: "Windows NT 10.0" } },
});

test("markdown file click normalizes a slash-prefixed Windows drive before opening", () => {
  const opened = [];
  const link = MarkdownLink({
    href: "/C:/repo/report.md",
    "data-local-path": "/C:/repo/report.md",
    onOpenFile: (path) => opened.push(path),
    onOpenExternal: () => assert.fail("a local file is not an external URL"),
  });
  link.props.onClick({ preventDefault() {} });
  assert.deepEqual(opened, ["C:/repo/report.md"]);
  assert.equal(link.props.href, "file:///C:/repo/report.md");
});

test("markdown file click resolves against its own document or session directory", () => {
  const opened = [];
  const link = MarkdownLink({
    href: "images/a%20b.png",
    "data-local-path": "images/a%20b.png",
    basePath: "C:/second-session",
    onOpenFile: (path) => opened.push(path),
    onOpenExternal: () => assert.fail("a local file is not an external URL"),
  });
  link.props.onClick({ preventDefault() {} });
  assert.deepEqual(opened, ["C:/second-session/images/a%20b.png"]);
  assert.equal(link.props.title, "C:/second-session/images/a%20b.png");
});

for (const userAgent of ["X11; Linux x86_64", "Macintosh; Intel Mac OS X"]) {
  test(`the Markdown browser link keeps POSIX backslashes in its href and click target on ${userAgent}`, () => {
    const { MarkdownLink: PosixMarkdownLink } = loadTsCommonJs("src/renderer/src/components/session/MarkdownLink.tsx", {
      stubs: { "../../i18n": i18n, "../../utils/notice": notices },
      globals: { process: undefined, navigator: { userAgent } },
    });
    const opened = [];
    const link = PosixMarkdownLink({
      href: String.raw`images\copy.png`, basePath: String.raw`/tmp/project\name`,
      onOpenFile: (path) => opened.push(path),
      onOpenExternal: () => assert.fail("local image must use the file callback"),
    });
    assert.equal(link.props.href, "file:///tmp/project%5Cname/images%5Ccopy.png");
    link.props.onClick({ preventDefault() {} });
    assert.deepEqual(opened, [String.raw`/tmp/project\name/images\copy.png`]);
  });
}

test("markdown document preview supplies working file and external callbacks and its own directory", async () => {
  const harness = createHookHarness();
  const store = createStore();
  const marker = () => null;
  const opened = [];
  const external = [];
  const { FileDiffViewer } = loadTsCommonJs(resolve("src/renderer/src/components/app/FileDiffViewer.tsx"), {
    stubs: {
      react: harness.react,
      // This hook-only fixture supplies the same store boundary as a React Provider.
      jotai: { atom, useStore: () => store },
      "../../i18n": i18n,
      "../../utils/notice": notices,
      "../../desktopApi": { desktopApi: { files: { open: async () => undefined }, app: { openExternal: async () => undefined } } },
      "../session/MarkdownStream": { MarkdownStream: marker },
      "./CodeMirrorEditor": { CodeMirrorEditor: marker },
      "../session/composer/chips": { formatFilePathRef: (path) => path },
      "../ui-shadcn/button": { Button: marker },
      "../../lib/utils": { cn: (...args) => args.filter(Boolean).join(" ") },
      "../../fileIcons": { getFileIconColor: () => "", getFileIconSeti: () => "" },
    },
    globals: { window: { addEventListener() {}, removeEventListener() {} } },
  });
  const props = {
    filePath: "C:/repo/docs/guide.md",
    onClose() {},
    readContent: async () => "[next](next.md)",
    onOpenFile: (path) => opened.push(path),
    onOpenExternal: (url) => external.push(url),
  };
  harness.render(() => FileDiffViewer(props));
  await flush();
  const tree = harness.render(() => FileDiffViewer(props));
  const preview = nodes(tree, (node) => node.type === marker && node.props.text === "[next](next.md)")[0];
  assert.ok(preview, "the document is rendered by MarkdownStream");
  assert.equal(preview.props.fileBasePath, "C:/repo/docs");
  assert.equal(typeof preview.props.onOpenFile, "function");
  preview.props.onOpenFile("C:/repo/docs/next.md");
  preview.props.onOpenExternal("https://example.com/docs");
  assert.deepEqual(opened, ["C:/repo/docs/next.md"]);
  assert.deepEqual(external, ["https://example.com/docs"]);
  harness.unmount();
});

test("native reveal propagates shell refusal and transport failure", async () => {
  const { NativeShell } = loadTsCommonJs(resolve("src/native-node/platform/NativeShell.ts"));
  const refused = new NativeShell({ request: async () => ({ ok: false, error: "Cannot reveal file" }) });
  await assert.rejects(async () => refused.showItemInFolder("C:/repo/a.md"), /Cannot reveal file/);
  const disconnected = new NativeShell({ request: async () => { throw new Error("Disconnected"); } });
  await assert.rejects(async () => disconnected.showItemInFolder("C:/repo/a.md"), /Disconnected/);
});
