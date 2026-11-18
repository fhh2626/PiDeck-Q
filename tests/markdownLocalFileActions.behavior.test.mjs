import assert from "node:assert/strict";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

/** Keep the menu primitives opaque while executing the real link and file actions. */
function menuPrimitives(React) {
  return {
    ContextMenu: ({ children }) => React.createElement(React.Fragment, null, children),
    ContextMenuTrigger: ({ children }) => children,
    ContextMenuContent: ({ children }) => React.createElement("div", { role: "menu" }, children),
    ContextMenuItem: ({ children, onSelect }) => React.createElement("button", { onClick: onSelect }, children),
  };
}

async function withLink({ path = "C:/project/docs", type = "directory", stat, userAgent = "Windows NT 10.0", nativeHost = true } = {}, run) {
  await withHookHost(async (host) => {
    const opened = [], revealed = [], notices = [];
    host.window.piDesktop = nativeHost ? { files: {
      stat: stat ?? (async () => ({ type })),
      showInFolder: async (target) => { revealed.push(target); },
    } } : undefined;
    const { MarkdownLink } = host.load("src/renderer/src/components/session/MarkdownLink.tsx", {
      globals: { navigator: { userAgent } },
      stubs: {
        "../../i18n": { t: (key) => key },
        "../../utils/notice": { showNotice: (...args) => notices.push(args) },
        "../ui-shadcn/context-menu": menuPrimitives(host.React),
      },
    });
    await host.mount(() => null, {}, () => host.React.createElement(MarkdownLink, {
      href: path,
      onOpenFile: (target) => opened.push(target),
      onOpenExternal: () => assert.fail("a local target cannot use the external URL API"),
    }, "target"));
    const click = async (element, extra = {}, eventName = "click") => {
      const event = new host.window.Event(eventName, { bubbles: true, cancelable: true });
      Object.assign(event, extra);
      await host.act(async () => element.dispatchEvent(event));
      return event;
    };
    await run({ ...host, opened, revealed, notices, click, anchor: host.window.document.querySelector("a") });
  });
}

for (const [userAgent, path] of [
  ["Windows NT 10.0", "C:/project/docs"],
  ["X11; Linux x86_64", "/project/docs"],
  ["Macintosh; Intel Mac OS X", "/project/docs"],
]) {
  test(`directory links show a folder icon and open the directory in the system file manager on ${userAgent}`, async () => {
    await withLink({ path, userAgent }, async ({ anchor, click, opened, revealed }) => {
      assert.ok(anchor.querySelector(".lucide-folder"), "the actual path type distinguishes a directory from a file");
      await click(anchor);
      assert.deepEqual(opened, [], "a directory must not enter the text/image editor");
      assert.deepEqual(revealed, [path]);
    });
  });
}

test("an extensionless file retains the normal preview action", async () => {
  await withLink({ path: "C:/project/LICENSE", type: "file" }, async ({ anchor, click, opened, revealed }) => {
    assert.ok(anchor.querySelector(".lucide-file-text"));
    await click(anchor);
    assert.deepEqual(opened, ["C:/project/LICENSE"]);
    assert.deepEqual(revealed, []);
  });
});

test("a directory whose name has a file extension still opens as a directory", async () => {
  await withLink({ path: "C:/project/cache.db" }, async ({ anchor, click, opened, revealed }) => {
    await click(anchor);
    assert.deepEqual(opened, []);
    assert.deepEqual(revealed, ["C:/project/cache.db"]);
  });
});

for (const extra of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
  test(`a modified local link click opens its containing folder ${JSON.stringify(extra)}`, async () => {
    await withLink({ path: "C:/project/report.md", type: "file" }, async ({ anchor, click, opened, revealed }) => {
      await click(anchor, extra);
      assert.deepEqual(opened, []);
      assert.deepEqual(revealed, ["C:/project/report.md"]);
    });
  });

  test(`a modified local click retains the file callback without a native host ${JSON.stringify(extra)}`, async () => {
    await withLink({ path: "C:/project/report.md", nativeHost: false }, async ({ anchor, click, opened, revealed }) => {
      const event = await click(anchor, extra);
      assert.equal(event.defaultPrevented, true);
      assert.deepEqual(opened, ["C:/project/report.md"]);
      assert.deepEqual(revealed, []);
    });
  });
}

test("a middle click without a native host uses the file callback instead of a blocked file URL", async () => {
  await withLink({ path: "C:/project/report.md", nativeHost: false }, async ({ anchor, click, opened, revealed }) => {
    const event = await click(anchor, { button: 1 }, "auxclick");
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(opened, ["C:/project/report.md"]);
    assert.deepEqual(revealed, []);
  });
});

test("a middle click opens a local file's folder without navigating the WebView", async () => {
  await withLink({ path: "C:/project/report.md", type: "file" }, async ({ anchor, click, opened, revealed }) => {
    const event = await click(anchor, { button: 1 }, "auxclick");
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(opened, []);
    assert.deepEqual(revealed, ["C:/project/report.md"]);
  });
});

test("the link context menu opens the containing folder through the authorized desktop API", async () => {
  await withLink({ path: "C:/project/report.md", type: "file" }, async ({ window, click, opened, revealed }) => {
    const item = [...window.document.querySelectorAll("button")].find((node) => node.textContent === "menu.openLinkInNewWindow");
    assert.ok(item, "local links have an application menu instead of the blocked browser new-window action");
    await click(item);
    assert.deepEqual(opened, []);
    assert.deepEqual(revealed, ["C:/project/report.md"]);
  });
});

test("a failed path authorization produces an error notice without opening another destination", async () => {
  await withLink({ stat: async () => { throw new Error("Path is outside the authorized roots"); } }, async ({ anchor, click, opened, revealed, notices }) => {
    await click(anchor);
    assert.deepEqual(opened, []);
    assert.deepEqual(revealed, []);
    assert.equal(notices.length, 1);
    assert.equal(notices[0][0], "app.openFileFailed");
  });
});

test("a link rechecks a path that an agent replaced with a directory after rendering", async () => {
  let type = "file";
  await withLink({ stat: async () => ({ type }) }, async ({ anchor, click, opened, revealed }) => {
    assert.ok(anchor.querySelector(".lucide-file-text"));
    type = "directory";
    await click(anchor);
    assert.deepEqual(opened, []);
    assert.deepEqual(revealed, ["C:/project/docs"]);
  });
});

test("user-message folder chips resolve against their own session and share native directory actions", async () => {
  await withHookHost(async (host) => {
    const revealed = [], opened = [];
    host.window.piDesktop = { files: {
      stat: async () => ({ type: "directory" }),
      showInFolder: async (path) => { revealed.push(path); },
    } };
    const context = host.React.createContext("C:/second-session");
    const { TimelineFileChip } = host.load("src/renderer/src/components/session/TimelineFileChip.tsx", {
      globals: { navigator: { userAgent: "Windows NT 10.0" } },
      stubs: {
        "./MarkdownFileBasePath": { MarkdownFileBasePathContext: context },
        "../../i18n": { t: (key) => key },
        "../ui-shadcn/context-menu": menuPrimitives(host.React),
      },
    });
    await host.mount(() => null, {}, () => host.React.createElement(TimelineFileChip, {
      chip: { kind: "file", raw: '@"my docs/"', label: "my docs/", start: 0, end: 11 },
      onOpenFile: (path) => { opened.push(path); },
    }));
    const anchor = host.window.document.querySelector("a");
    assert.ok(anchor.querySelector(".lucide-folder"));
    assert.equal(anchor.getAttribute("href"), "file:///C:/second-session/my%20docs");
    await host.act(async () => anchor.dispatchEvent(new host.window.Event("click", { bubbles: true, cancelable: true })));
    assert.deepEqual(revealed, ["C:/second-session/my docs"]);
    assert.deepEqual(opened, []);
  });
});
