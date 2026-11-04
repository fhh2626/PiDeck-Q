import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createFakeRouter } from "./helpers/l3_ipcHarness.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { registerFilesIpc } = loadTsCommonJs("src/main/ipc/filesIpc.ts");

function registerWith(router, overrides = {}) {
  const shell = { opened: [], shown: [] };
  registerFilesIpc(router, {
    fileSystemService: {},
    projectStore: { get: () => undefined },
    settingsStore: { get: () => ({ wslEnabled: false }) },
    appLogger: { info() {}, error() {} },
    dialogs: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    platformShell: {
      openPath: async (path) => { shell.opened.push(path); return { ok: true }; },
      showItemInFolder: (path) => { shell.shown.push(path); },
    },
    getAuthorizedRoots: () => [],
    ...overrides,
  });
  return shell;
}

/** 一个已授权根目录 + 一个根外目录，均为真实临时目录。 */
async function createSandbox(t) {
  const base = await mkdtemp(join(tmpdir(), "pideck-l3-files-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "root");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  return { root, outside };
}

/**
 * 回归（30b6954b）：新增 files:copy/files:move 时误删了 filesShowInFolder
 * handler，渲染层右键「在文件夹中显示」报 No handler registered。
 * 任何 files:* 通道漏注册（或反向误删）都会让本测试先红。
 */
test("every files:* channel in shared/ipc.ts has a handler registered by registerFilesIpc", () => {
  const channelKeys = Object.entries(ipcChannels)
    .filter(([key, value]) => key.startsWith("files") && String(value).startsWith("files:"))
    .map(([key]) => key);
  assert.ok(channelKeys.length >= 10, `expected files:* channels, got ${channelKeys.length}`);

  const router = createFakeRouter();
  registerWith(router);
  const missing = channelKeys.filter((key) => !router.handlers.has(ipcChannels[key]));
  assert.deepEqual(missing, [], "registerFilesIpc must register a handler for every files:* channel");
});

test("files:show-in-folder authorizes the Windows-converted path before opening the folder", async () => {
  const authorized = [];
  const { registerFilesIpc: register } = loadTsCommonJs("src/main/ipc/filesIpc.ts", {
    stubs: {
      "../fs/authorizedPaths": {
        assertAuthorizedFilePath: async (target, _roots, operation) => {
          authorized.push([target, operation]);
          if (target.includes("outside")) throw Object.assign(new Error("denied"), { code: "FILE_PATH_NOT_AUTHORIZED" });
          return `canon:${target}`;
        },
      },
    },
  });
  const router = createFakeRouter();
  const shown = [];
  register(router, {
    fileSystemService: {},
    projectStore: { get: () => undefined },
    // WSL 开启：/mnt/c 路径必须先转成 Windows 路径，WSL 里的文件才能被系统文件管理器定位
    settingsStore: { get: () => ({ wslEnabled: true, wslDistro: "Ubuntu" }) },
    appLogger: { info() {}, error() {} },
    dialogs: {},
    platformShell: { openPath: async () => ({ ok: true }), showItemInFolder: (p) => shown.push(p) },
    getAuthorizedRoots: () => ["C:\\project"],
  });

  await router.invoke(ipcChannels.filesShowInFolder, "/mnt/c/project/file.txt");
  assert.deepEqual(authorized, [["C:\\project\\file.txt", "show-in-folder"]]);
  assert.deepEqual(shown, ["canon:C:\\project\\file.txt"], "shell must get the authorization result, not the raw input");

  await assert.rejects(router.invoke(ipcChannels.filesShowInFolder, "/mnt/c/outside/x.txt"), /denied/);
  assert.equal(shown.length, 1, "an unauthorized path must never reach the shell");
});

test("files:write-content refuses a path outside the authorized roots without writing", async (t) => {
  const { root, outside } = await createSandbox(t);
  const router = createFakeRouter();
  registerWith(router, { getAuthorizedRoots: () => [root] });
  const target = join(outside, "pwned.txt");

  await assert.rejects(router.invoke(ipcChannels.filesWriteContent, target, "x"), (e) => e.code === "FILE_PATH_NOT_AUTHORIZED");
  assert.equal(existsSync(target), false);

  const inside = join(root, "ok.txt");
  await router.invoke(ipcChannels.filesWriteContent, inside, "hello");
  assert.equal(await readFile(inside, "utf8"), "hello");
});

test("files:copy refuses an unauthorized target or source before copying anything", async (t) => {
  const { root, outside } = await createSandbox(t);
  const router = createFakeRouter();
  registerWith(router, { getAuthorizedRoots: () => [root] });
  const inside = join(root, "a.txt");
  const secret = join(outside, "secret.txt");
  await writeFile(inside, "a");
  await writeFile(secret, "s");

  for (const channel of [ipcChannels.filesCopy, ipcChannels.filesCopyInternal]) {
    await assert.rejects(router.invoke(channel, [inside], outside), (e) => e.code === "FILE_PATH_NOT_AUTHORIZED");
    assert.equal(existsSync(join(outside, "a.txt")), false, "nothing may be copied to an unauthorized target");
    await assert.rejects(router.invoke(channel, [secret], root), (e) => e.code === "FILE_PATH_NOT_AUTHORIZED");
    assert.equal(existsSync(join(root, "secret.txt")), false, "an unauthorized source may not be pulled in");
  }
});

test("files:move refuses an unauthorized target or source and leaves the source in place", async (t) => {
  const { root, outside } = await createSandbox(t);
  const router = createFakeRouter();
  registerWith(router, { getAuthorizedRoots: () => [root] });
  const inside = join(root, "a.txt");
  const secret = join(outside, "secret.txt");
  await writeFile(inside, "a");
  await writeFile(secret, "s");

  await assert.rejects(router.invoke(ipcChannels.filesMove, [inside], outside), (e) => e.code === "FILE_PATH_NOT_AUTHORIZED");
  assert.equal(existsSync(inside), true);
  assert.equal(existsSync(join(outside, "a.txt")), false);

  await assert.rejects(router.invoke(ipcChannels.filesMove, [secret], root), (e) => e.code === "FILE_PATH_NOT_AUTHORIZED");
  assert.equal(existsSync(secret), true);
  assert.equal(existsSync(join(root, "secret.txt")), false);
});

/**
 * 在授权根内建一个指向根外目录的链接（junction 在 Windows 上无需特权；POSIX 上是普通目录符号链接）。
 * 创建失败（受限环境）时跳过，而不是让测试变成假阳性。
 */
async function createLinkToOutside(t, { root, outside }, name = "link") {
  const link = join(root, name);
  try {
    await symlink(outside, link, "junction");
  } catch (error) {
    t.skip(`cannot create a directory link here: ${error.code ?? error.message}`);
    return null;
  }
  return link;
}

test("deleting or renaming a link inside the root operates on the link itself, never on its referent", async (t) => {
  const sandbox = await createSandbox(t);
  const link = await createLinkToOutside(t, sandbox);
  if (!link) return;
  await writeFile(join(sandbox.outside, "precious.txt"), "keep");
  const calls = [];
  const router = createFakeRouter();
  registerWith(router, {
    getAuthorizedRoots: () => [sandbox.root],
    fileSystemService: {
      delete: async (path, recursive) => { calls.push(["delete", path, recursive]); },
      rename: async (path, newName) => { calls.push(["rename", path, newName]); return join(sandbox.root, newName); },
    },
  });

  await router.invoke(ipcChannels.filesDelete, link, true);
  await router.invoke(ipcChannels.filesRename, link, "renamed");

  // 交给文件系统服务的必须是链接本身的词法路径；解析成根外的真实目录会把删除/改名打到根外。
  assert.deepEqual(calls.map(([op, path]) => [op, path]), [["delete", link], ["rename", link]]);
  assert.equal(await readFile(join(sandbox.outside, "precious.txt"), "utf8"), "keep");
});

test("moving a link inside the root moves the link itself and leaves its referent untouched", async (t) => {
  const sandbox = await createSandbox(t);
  const link = await createLinkToOutside(t, sandbox);
  if (!link) return;
  await writeFile(join(sandbox.outside, "precious.txt"), "keep");
  await mkdir(join(sandbox.root, "dest"));
  const router = createFakeRouter();
  registerWith(router, { getAuthorizedRoots: () => [sandbox.root] });

  const [moved] = await router.invoke(ipcChannels.filesMove, [link], join(sandbox.root, "dest"));

  assert.equal(moved, join(sandbox.root, "dest", "link"));
  assert.equal(existsSync(link), false, "the link is gone from its old place");
  assert.equal((await lstat(moved)).isSymbolicLink(), true, "the link itself was moved, not its target copied");
  assert.equal(await readFile(join(sandbox.outside, "precious.txt"), "utf8"), "keep", "the referent must be untouched");
});
test("a path that reaches outside the root through a link in its parent chain is refused for delete, rename and move", async (t) => {
  const sandbox = await createSandbox(t);
  const link = await createLinkToOutside(t, sandbox);
  if (!link) return;
  const viaLink = join(link, "secret.txt");
  await writeFile(join(sandbox.outside, "secret.txt"), "s");
  await mkdir(join(sandbox.root, "dest"));
  const touched = [];
  const router = createFakeRouter();
  registerWith(router, {
    getAuthorizedRoots: () => [sandbox.root],
    fileSystemService: {
      delete: async (path) => { touched.push(["delete", path]); },
      rename: async (path) => { touched.push(["rename", path]); },
    },
  });
  const denied = (error) => error.code === "FILE_PATH_NOT_AUTHORIZED";

  await assert.rejects(router.invoke(ipcChannels.filesDelete, viaLink), denied);
  await assert.rejects(router.invoke(ipcChannels.filesRename, viaLink, "x.txt"), denied);
  await assert.rejects(router.invoke(ipcChannels.filesMove, [viaLink], join(sandbox.root, "dest")), denied);

  assert.deepEqual(touched, [], "no mutation may be attempted through the link");
  assert.equal(await readFile(join(sandbox.outside, "secret.txt"), "utf8"), "s");
  assert.equal(existsSync(join(sandbox.root, "dest", "secret.txt")), false);
});

test("reading or writing through a link inside the root is refused (only link operations may touch the link itself)", async (t) => {
  const sandbox = await createSandbox(t);
  const link = await createLinkToOutside(t, sandbox);
  if (!link) return;
  const router = createFakeRouter();
  registerWith(router, { getAuthorizedRoots: () => [sandbox.root] });

  await assert.rejects(
    router.invoke(ipcChannels.filesWriteContent, join(link, "pwned.txt"), "x"),
    (error) => error.code === "FILE_PATH_NOT_AUTHORIZED",
  );
  assert.equal(existsSync(join(sandbox.outside, "pwned.txt")), false);
});
test("a link whose referent is inside the root is still never followed for writes (dangling-link TOCTOU)", async (t) => {
  const { root } = await createSandbox(t);
  const real = join(root, "real");
  await mkdir(real);
  const link = join(root, "alias");
  try {
    await symlink(real, link, "junction");
  } catch (error) {
    t.skip(`cannot create a directory link here: ${error.code ?? error.message}`);
    return;
  }
  const router = createFakeRouter();
  registerWith(router, { getAuthorizedRoots: () => [root] });

  // 链接当前指向根内，但检查与使用之间它可以被改指向别处：只要最后一段是链接就一律拒绝。
  await assert.rejects(
    router.invoke(ipcChannels.filesWriteContent, link, "x"),
    (error) => error.code === "FILE_PATH_NOT_AUTHORIZED",
  );
});
test("files:copy and files:move authorize the target directory up front, even with nothing to transfer", async (t) => {
  // 目标目录的授权不依赖逐项检查：空源列表也不能探测/确认根外目录。
  const { root, outside } = await createSandbox(t);
  const router = createFakeRouter();
  registerWith(router, { getAuthorizedRoots: () => [root] });
  for (const channel of [ipcChannels.filesCopy, ipcChannels.filesCopyInternal, ipcChannels.filesMove]) {
    await assert.rejects(router.invoke(channel, [], outside), (e) => e.code === "FILE_PATH_NOT_AUTHORIZED", channel);
    assert.equal((await router.invoke(channel, [], root)).length, 0, channel);
  }
});

test("files:copy-external only copies what a native capability grants", async (t) => {
  const { root, outside } = await createSandbox(t);
  const granted = join(outside, "clip.txt");
  await writeFile(granted, "clip");
  const consumed = [];
  const router = createFakeRouter();
  registerWith(router, {
    getAuthorizedRoots: () => [root],
    externalFileCapabilities: {
      consumeCopy: (id) => { consumed.push(id); return id === "cap-1" ? [granted] : undefined; },
    },
  });

  // 能力无效：不凭渲染层自报路径复制
  await assert.rejects(router.invoke(ipcChannels.filesCopyExternal, "bogus", root), /capability is unavailable/);
  // 目标未授权时不应消耗能力
  consumed.length = 0;
  await assert.rejects(router.invoke(ipcChannels.filesCopyExternal, "cap-1", outside), (e) => e.code === "FILE_PATH_NOT_AUTHORIZED");
  assert.deepEqual(consumed, []);

  const [dest] = await router.invoke(ipcChannels.filesCopyExternal, "cap-1", root);
  assert.equal(await readFile(dest, "utf8"), "clip");
});

test("files:copy-external fails closed when no capability store is wired", async (t) => {
  const { root } = await createSandbox(t);
  const router = createFakeRouter();
  registerWith(router, { getAuthorizedRoots: () => [root] });
  await assert.rejects(router.invoke(ipcChannels.filesCopyExternal, "cap-1", root), /capability is unavailable/);
});

test("files:read-base64-external reads the capability's trusted path, not the renderer's claim", async (t) => {
  const { outside } = await createSandbox(t);
  const trusted = join(outside, "trusted.bin");
  await writeFile(trusted, "hello");
  const router = createFakeRouter();
  registerWith(router, {
    externalFileCapabilities: {
      consumeRead: (id, claimed) => (id === "cap-1" && claimed === "C:/claimed.png" ? trusted : undefined),
    },
  });

  assert.equal(await router.invoke(ipcChannels.filesReadBase64External, "cap-1", "C:/claimed.png", 1024), Buffer.from("hello").toString("base64"));
  await assert.rejects(router.invoke(ipcChannels.filesReadBase64External, "cap-2", "C:/claimed.png", 1024), /capability is unavailable/);
  // maxBytes 必须有界，防止渲染层请求无限读取
  await assert.rejects(router.invoke(ipcChannels.filesReadBase64External, "cap-1", "C:/claimed.png", 10 * 1024 * 1024 + 1), /maxBytes/);
});

test("files IPC does not import the native-node entry", () => {
  // 静态分层规则：领域 IPC 模块不得反向依赖入口，文本匹配是此类规则的合适手段。
  assert.doesNotMatch(readFileSync("src/main/ipc/filesIpc.ts", "utf8"), /from\s+["']\.\.\/index["']/);
});
