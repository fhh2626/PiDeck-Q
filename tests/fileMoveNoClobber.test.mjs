import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function moveHandler(root, overrides) {
 const { registerFilesIpc } = loadTsCommonJs("src/main/ipc/filesIpc.ts", {
  stubs: { "node:fs/promises": { ...fs, ...overrides } },
 });
 const handlers = new Map();
 registerFilesIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
  fileSystemService: {}, projectStore: {}, settingsStore: { get: () => ({ wslEnabled: false }) },
  appLogger: { info() {}, error() {} }, dialogs: {}, platformShell: {}, getAuthorizedRoots: () => [root],
  mainCopy: key => `translated:${key}`,
 });
 return handlers.get("files:move");
}

test("move refuses a file appearing immediately before the exclusive copy primitive", async () => {
 const root = await fs.mkdtemp(join(tmpdir(), "pideck-move-exclusive-"));
 try {
  const src = join(root, "source", "file.txt"); const target = join(root, "target"); const dest = join(target, "file.txt");
  await fs.mkdir(join(root, "source")); await fs.mkdir(target); await fs.writeFile(src, "source");
  const move = moveHandler(root, { copyFile: async (from, to, mode) => {
   await fs.writeFile(to, "rival"); return fs.copyFile(from, to, mode);
  } });
  await assert.rejects(() => move([src], target), /exist/i);
  assert.equal(await fs.readFile(src, "utf8"), "source"); assert.equal(await fs.readFile(dest, "utf8"), "rival");
 } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("move refuses a directory appearing immediately before its exclusive reservation", async () => {
 const root = await fs.mkdtemp(join(tmpdir(), "pideck-move-directory-"));
 try {
  const src = join(root, "source", "folder"); const target = join(root, "target"); const dest = join(target, "folder");
  await fs.mkdir(src, { recursive: true }); await fs.mkdir(target); await fs.writeFile(join(src, "source.txt"), "source");
  const move = moveHandler(root, { mkdir: async (path, options) => {
   if (path === dest) { await fs.mkdir(dest); await fs.writeFile(join(dest, "rival.txt"), "rival"); }
   return fs.mkdir(path, options);
  } });
  await assert.rejects(() => move([src], target), /exist/i);
  assert.equal(await fs.readFile(join(src, "source.txt"), "utf8"), "source");
  assert.equal(await fs.readFile(join(dest, "rival.txt"), "utf8"), "rival");
  await assert.rejects(() => fs.readFile(join(dest, "source.txt")), /ENOENT/);
 } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("move preserves a rival nested directory and retains the complete source", async () => {
 const root = await fs.mkdtemp(join(tmpdir(), "pideck-move-nested-race-"));
 try {
  const src = join(root, "source", "folder"); const target = join(root, "target");
  const nestedDest = join(target, "folder", "nested");
  await fs.mkdir(join(src, "nested"), { recursive: true }); await fs.mkdir(target);
  await fs.writeFile(join(src, "nested", "source.txt"), "source");
  const move = moveHandler(root, { mkdir: async (path, options) => {
   if (path === nestedDest) { await fs.mkdir(path); await fs.writeFile(join(path, "rival.txt"), "rival"); }
   return fs.mkdir(path, options);
  } });
  await assert.rejects(() => move([src], target), /exist/i);
  assert.equal(await fs.readFile(join(src, "nested", "source.txt"), "utf8"), "source");
  assert.equal(await fs.readFile(join(nestedDest, "rival.txt"), "utf8"), "rival");
  await assert.rejects(() => fs.readFile(join(nestedDest, "source.txt")), /ENOENT/);
 } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("move preserves a directory link without deleting its referent", async (context) => {
 const root = await fs.mkdtemp(join(tmpdir(), "pideck-move-link-"));
 try {
  const src = join(root, "source", "folder"); const target = join(root, "target"); const outside = join(root, "outside");
  await fs.mkdir(src, { recursive: true }); await fs.mkdir(target); await fs.mkdir(outside);
  await fs.writeFile(join(outside, "keep.txt"), "keep");
  const link = join(src, "linked");
  try { await fs.symlink(outside, link, "junction"); }
  catch (error) { if (["EPERM", "ENOTSUP"].includes(error.code)) { context.skip("Directory links unavailable."); return; } throw error; }
  const originalLink = await fs.readlink(link);
  await moveHandler(root, {})([src], target);
  const copiedLink = join(target, "folder", "linked");
  assert.equal((await fs.lstat(copiedLink)).isSymbolicLink(), true);
  assert.equal(await fs.readlink(copiedLink), originalLink);
  assert.equal(await fs.readFile(join(outside, "keep.txt"), "utf8"), "keep");
  await assert.rejects(() => fs.lstat(src), /ENOENT/);
 } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("move rejects special file types with localized IPC copy and preserves the source", async () => {
 const root = await fs.mkdtemp(join(tmpdir(), "pideck-move-special-"));
 try {
  const src = join(root, "source", "special"); const target = join(root, "target");
  await fs.mkdir(join(root, "source")); await fs.mkdir(target); await fs.writeFile(src, "source");
  const move = moveHandler(root, { lstat: async path => path === src
   ? { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false }
   : fs.lstat(path) });
  await assert.rejects(() => move([src], target), /translated:mainFile.unsupportedMoveType/);
  assert.equal(await fs.readFile(src, "utf8"), "source");
  await assert.rejects(() => fs.lstat(join(target, "special")), /ENOENT/);
 } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("move copies nested directories completely before removing the source", async () => {
 const root = await fs.mkdtemp(join(tmpdir(), "pideck-move-nested-"));
 try {
  const src = join(root, "source", "folder"); const target = join(root, "target");
  await fs.mkdir(join(src, "nested"), { recursive: true }); await fs.mkdir(target);
  await fs.writeFile(join(src, "nested", "file.txt"), "payload");
  const result = await moveHandler(root, {})([src], target);
  assert.equal(result[0], join(target, "folder"));
  assert.equal(await fs.readFile(join(target, "folder", "nested", "file.txt"), "utf8"), "payload");
  await assert.rejects(() => fs.lstat(src), /ENOENT/);
 } finally { await fs.rm(root, { recursive: true, force: true }); }
});
