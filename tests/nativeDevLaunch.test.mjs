import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import * as dev from "../scripts/dev-native.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pideck-dev-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.5.0" }));
  return root;
}

async function putExecutable(root, stage) {
  const file = resolve(root, stage, "PiDeck-Q.exe");
  await mkdir(resolve(file, ".."), { recursive: true });
  await writeFile(file, "fixture");
  return file;
}

test("Windows dev builds invoke the npm JS CLI through Node without a command shell", async (t) => {
  const root = await fixture(t);
  await putExecutable(root, "release/win-unpacked");
  const calls = [];
  await dev.runNativeDev({
    repoRoot: root, platform: "win32", nodeExecutable: "C:/tools/node.exe",
    environment: { npm_execpath: "C:/tools/node_modules/npm/bin/npm-cli.js", APPDATA: root },
    run: async (...args) => { calls.push(args); },
  });
  assert.deepEqual(calls.slice(0, 2).map(([command, args]) => [command, args]), [
    ["C:/tools/node.exe", ["C:/tools/node_modules/npm/bin/npm-cli.js", "run", "build:renderer"]],
    ["C:/tools/node.exe", ["C:/tools/node_modules/npm/bin/npm-cli.js", "run", "build:webfetch"]],
  ]);
  for (const [, , options] of calls) {
    assert.equal(options.cwd, root);
    assert.equal(options.shell, undefined);
  }
  assert.equal(calls[2][2].env.PIDECK_VERSION, "0.5.0");
  assert.equal(calls[3][2].env.PIDECK_VERSION, "0.5.0");
  assert.equal(calls[4][2].env.PIDECK_VERSION, "0.5.0-dev");
  assert.equal(calls[4][2].env.PIDECK_PACKAGED, "0");
});

test("dev launches the configured stage instead of a stale executable in the default stage", async (t) => {
  const root = await fixture(t);
  await putExecutable(root, "release/win-unpacked");
  const expected = await putExecutable(root, "custom stage");
  const calls = [];
  await dev.runNativeDev({
    repoRoot: root, platform: "win32", environment: { PIDECK_STAGE_DIR: "custom stage", APPDATA: root },
    run: async (...args) => { calls.push(args); },
  });
  assert.equal(calls.at(-1)[0], expected);
  assert.equal(calls[2][2].env.PIDECK_STAGE_DIR, resolve(root, "custom stage"));
});

test("a missing configured executable fails without launching the stale default", async (t) => {
  const root = await fixture(t);
  await putExecutable(root, "release/win-unpacked");
  const calls = [];
  await assert.rejects(dev.runNativeDev({
    repoRoot: root, platform: "win32", environment: { PIDECK_STAGE_DIR: "missing" },
    run: async (...args) => { calls.push(args); },
  }), /Native debug executable was not found/);
  assert.equal(calls.length, 4);
});

test("a failed native build never starts an older staged executable", async (t) => {
  const root = await fixture(t);
  await putExecutable(root, "release/win-unpacked");
  const calls = [];
  await assert.rejects(dev.runNativeDev({
    repoRoot: root, platform: "win32", environment: {},
    run: async (...args) => {
      calls.push(args);
      if (args[1][0] === "-r") throw new Error("native build failed");
    },
  }), /native build failed/);
  assert.equal(calls.length, 4);
});
