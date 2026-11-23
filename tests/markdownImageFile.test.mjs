import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createHookHarness, deferred, flush } from "./helpers/imagePreviewHarness.mjs";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

function imageHarness(readBase64, userAgent = "Windows NT 10.0") {
  const harness = createHookHarness();
  const { MarkdownImage } = loadTsCommonJs(resolve("src/renderer/src/components/session/MarkdownImage.tsx"), {
    stubs: {
      react: harness.react,
      "../../desktopApi": { desktopApi: { files: { readBase64 } } },
      "../../i18n": { t: (key) => key },
    },
    globals: { process: undefined, navigator: { userAgent } },
  });
  return { ...harness, image: (props) => harness.render(() => MarkdownImage(props)) };
}

test("a relative Markdown image uses its session file API and opens the real path", async () => {
  const reads = [];
  const opened = [];
  const harness = imageHarness(async (...args) => { reads.push(args); return "aGVsbG8="; });
  const props = {
    src: "images/diagram%2520one.png",
    "data-local-path": "images/diagram%20one.png",
    basePath: "C:/second-session",
    onOpenFile: (path) => opened.push(path),
  };
  const loading = harness.image(props);
  assert.equal(loading.type, "span");
  assert.equal(loading.props.src, undefined);
  await flush();
  const image = harness.image(props);
  assert.deepEqual(reads, [["C:/second-session/images/diagram%20one.png", 10 * 1024 * 1024]]);
  assert.equal(image.props.src, "data:image/png;base64,aGVsbG8=");
  image.props.onClick({ currentTarget: { closest: () => null }, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(opened, ["C:/second-session/images/diagram%20one.png"]);
  harness.unmount();
});

test("a stale Markdown image read cannot replace a newer document's image", async () => {
  const first = deferred();
  const second = deferred();
  const harness = imageHarness((path) => path.endsWith("first.png") ? first.promise : second.promise);
  harness.image({ src: "first.png", basePath: "C:/repo" });
  harness.image({ src: "second.png", basePath: "C:/repo" });
  second.resolve("c2Vjb25k");
  await flush();
  first.resolve("Zmlyc3Q=");
  await flush();
  const image = harness.image({ src: "second.png", basePath: "C:/repo" });
  assert.equal(image.props.src, "data:image/png;base64,c2Vjb25k");
  harness.unmount();
});

test("invalid file URL separators and missing local bases never fall back to HTTP", async () => {
  const reads = [];
  const harness = imageHarness(async (path) => { reads.push(path); return ""; });
  const invalid = harness.image({ src: "file:///C:/repo/a%2Fb.png", basePath: "C:/repo" });
  assert.equal(invalid.props.role, "alert");
  const unresolved = harness.image({ src: "image.png" });
  assert.equal(unresolved.props.role, "alert");
  assert.deepEqual(reads, []);
  const remote = harness.image({ src: "https://example.com/image.png" });
  assert.equal(remote.props.src, "https://example.com/image.png");
  harness.unmount();
});

test("authorization and decode failures are visible for a local Markdown image", async () => {
  const harness = imageHarness(async () => { throw new Error("FILE_PATH_NOT_AUTHORIZED"); });
  const props = { src: "image.png", basePath: "C:/repo" };
  harness.image(props);
  await flush();
  const failed = harness.image(props);
  assert.equal(failed.props.role, "alert");
  assert.equal(failed.props.children, "app.imageReadFailed");
  harness.unmount();
});

for (const userAgent of ["X11; Linux x86_64", "Macintosh; Intel Mac OS X"]) {
  test(`a POSIX Markdown image reads and opens literal backslashes on ${userAgent}`, async () => {
    const reads = [];
    const opened = [];
    const harness = imageHarness(async (path) => { reads.push(path); return "aGVsbG8="; }, userAgent);
    try {
      const props = {
        src: String.raw`images\copy.png`, basePath: String.raw`/tmp/project\name`,
        onOpenFile: (path) => opened.push(path),
      };
      harness.image(props);
      await flush();
      const image = harness.image(props);
      assert.equal(image.props.src, "data:image/png;base64,aGVsbG8=");
      assert.deepEqual(reads, [String.raw`/tmp/project\name/images\copy.png`]);
      image.props.onClick({ currentTarget: { closest: () => null }, preventDefault() {}, stopPropagation() {} });
      assert.deepEqual(opened, reads);
    } finally {
      harness.unmount();
    }
  });

  test(`a POSIX Markdown image retains its absolute drive-like directory on ${userAgent}`, async () => {
    const reads = [];
    const harness = imageHarness(async (path) => { reads.push(path); return "aGVsbG8="; }, userAgent);
    try {
      const props = { src: "file:///C:/reports/chart.png", basePath: "/workspace" };
      harness.image(props);
      await flush();
      assert.deepEqual(reads, ["/C:/reports/chart.png"]);
      assert.equal(harness.image(props).props.title, "/C:/reports/chart.png");
    } finally {
      harness.unmount();
    }
  });

  test(`the desktop image preview keeps the browser's POSIX path on ${userAgent}`, async () => {
    const harness = createHookHarness();
    const reads = [];
    const { useImagePreviewController } = loadTsCommonJs("src/renderer/src/hooks/useImagePreviewController.ts", {
      stubs: { react: harness.react, "../i18n": { t: (key) => key } },
      globals: { process: undefined, navigator: { userAgent } },
    });
    const options = {
      readBase64: async (path) => { reads.push(path); return "aGVsbG8="; },
      openFile: async () => {}, showToast: (message) => assert.fail(message),
    };
    try {
      const controller = harness.render(() => useImagePreviewController(options));
      assert.equal(controller.openLocalImage("/C:/reports/chart.png"), true);
      await flush();
      assert.deepEqual(reads, ["/C:/reports/chart.png"]);
      assert.equal(harness.render(() => useImagePreviewController(options)).previewImage.localSourcePath,
        "/C:/reports/chart.png");
    } finally {
      harness.unmount();
    }
  });
}

for (const href of ["full.png", "guide.md", "https://example.com/guide"]) {
  test(`a linked local image keeps its anchor target and keyboard focus for ${href}`, async () => {
    await withHookHost(async (host) => {
      const opened = [];
      const external = [];
      const shared = {
        "../../desktopApi": { desktopApi: { files: { readBase64: async () => "aGVsbG8=" } } },
        "../../i18n": { t: (key) => key },
      };
      const links = host.load("src/renderer/src/components/session/MarkdownLink.tsx", { stubs: shared });
      const { MarkdownImage } = host.load("src/renderer/src/components/session/MarkdownImage.tsx", {
        // Both actual components share the same context instance across the test loader roots.
        stubs: { ...shared, "./MarkdownLink": links },
      });
      await host.mount(() => null, {}, () => host.React.createElement(links.MarkdownLink, {
        href, basePath: "C:/docs", onOpenFile: (path) => opened.push(path),
        onOpenExternal: (url) => external.push(url),
      }, host.React.createElement(MarkdownImage, {
        src: "thumb.png", basePath: "C:/docs", onOpenFile: (path) => opened.push(path), alt: "thumbnail",
      })));
      const img = host.window.document.querySelector("img");
      assert.ok(img, "the thumbnail has finished loading through the file API");
      await host.act(async () => img.dispatchEvent(new host.window.Event("click", { bubbles: true, cancelable: true })));
      assert.deepEqual(opened, href.startsWith("https:") ? [] : [`C:/docs/${href}`]);
      assert.deepEqual(external, href.startsWith("https:") ? [href] : []);
      assert.equal(img.getAttribute("role"), null, "the enclosing anchor owns the image's interaction");
      assert.equal(img.getAttribute("tabindex"), null, "keyboard users focus the anchor once");
    });
  });
}
