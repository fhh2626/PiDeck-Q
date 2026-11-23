import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { backendTestAvailability, createFakePi, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { writeSessionFile } from "./helpers/native2RuntimeEvents.mjs";

const { skip } = backendTestAvailability();
const directoryLink = (target, path) => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");

/** A candidate can traverse a deleted entry even when its final file and companion are outside. */
async function fixture(t, intermediateLink) {
  let parent, child, outsideFile, configuredAlias, replacementRoot;
  let fileLinksAvailable = true;
  const f = await startBackendSession(t, {
    hostHandlers: { "shell.trashItem": () => undefined },
    prepare(directory) {
      const project = join(directory.root, "project");
      mkdirSync(join(project, ".pi"), { recursive: true });
      writeFileSync(join(directory.userData, "projects.json"), JSON.stringify([
        { id: "candidate-alias", path: project, name: "Candidate aliases", environment: "windows" },
      ]));
      configuredAlias = join(directory.root, "configured-session-root-alias-longer-than-default");
      const alternateAlias = join(directory.root, "alternate-session-alias");
      directoryLink(directory.sessions, configuredAlias);
      directoryLink(directory.sessions, alternateAlias);
      writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ sessionDir: configuredAlias }));
      replacementRoot = join(directory.root, "replacement-root");
      mkdirSync(replacementRoot);
      parent = writeSessionFile(directory.sessions, project, "parent");
      const companion = parent.slice(0, -6);
      mkdirSync(companion);
      const outside = join(directory.root, "outside-child");
      mkdirSync(outside);
      outsideFile = writeSessionFile(outside, project, "child");
      mkdirSync(join(outside, "child"));
      if (intermediateLink) {
        directoryLink(outside, join(companion, "nested"));
        child = join(alternateAlias, "parent", "nested", "child.jsonl");
      } else {
        try { symlinkSync(outsideFile, join(companion, "child.jsonl"), "file"); }
        catch (error) {
          if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
          fileLinksAvailable = false;
        }
        directoryLink(join(outside, "child"), join(companion, "child"));
        child = join(alternateAlias, "parent", "child.jsonl");
      }
      const unrelated = writeSessionFile(directory.sessions, project, "unrelated");
      const sessions = [["parent", join(configuredAlias, "parent.jsonl")], ["child", child], ["unrelated", unrelated]]
        .map(([id, filePath]) => ({ id, filePath, projectId: "candidate-alias", title: id,
          environment: "native", source: "pi", originKey: `candidate-${id}`, status: "active", createdAt: 1, updatedAt: 1 }));
      writeFileSync(join(directory.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions }));
      const fake = createFakePi(directory, {});
      return { settings: { customPiPath: fake.shim }, env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath } };
    },
  });
  return { ...f, parent, child, outsideFile, configuredAlias, replacementRoot, fileLinksAvailable };
}

for (const intermediateLink of [false, true]) {
  test(`native deletion blocks a candidate using ${intermediateLink ? "an intermediate directory link through another root alias" : "JSONL and companion leaf links"}`, { skip }, async (t) => {
    const f = await fixture(t, intermediateLink);
    if (!f.fileLinksAvailable) return t.skip("Windows file symlink creation is unavailable for this fixture");
    const original = readFileSync(f.outsideFile, "utf8");
    assert.equal(readFileSync(f.child, "utf8"), original);
    const deletion = f.invoke("sessions:catalog-delete", ["parent"]);
    const pending = await f.host.waitForRequest("shell.trashItem");
    try {
      assert.equal(pending.params.path.replaceAll("\\", "/"), f.parent.slice(0, -6).replaceAll("\\", "/"));
      // The other alias still traverses the original physical companion. Moving
      // that companion removes its links, even though their referents stay outside.
      unlinkSync(f.configuredAlias);
      directoryLink(f.replacementRoot, f.configuredAlias);
      const activation = await f.invoke("sessions:runtime-activate", ["child"]);
      assert.equal(activation.payload.result.ok, false, JSON.stringify(activation.payload));
      const unrelated = await f.invoke("sessions:runtime-activate", ["unrelated"]);
      assert.equal(unrelated.payload.result.ok, true, JSON.stringify(unrelated.payload));
    } finally {
      f.host.respond(pending.id, { status: "trash-failed" });
      assert.equal((await deletion).payload.result.status, "trash-failed");
    }
    const retry = await f.invoke("sessions:runtime-activate", ["child"]);
    assert.equal(retry.payload.result.ok, true, JSON.stringify(retry.payload));
    assert.equal(readFileSync(f.outsideFile, "utf8"), original);
    assert.ok(existsSync(f.parent));
  });
}

test("native deletion respects POSIX link and parent traversal in a live session path", {
  skip: skip || (process.platform === "win32" ? "Windows normalizes parent traversal before filesystem lookup" : false),
}, async (t) => {
  let parent, child, runtimePath;
  const f = await startBackendSession(t, {
    prepare(directory) {
      const project = join(directory.root, "project");
      mkdirSync(project);
      writeFileSync(join(directory.userData, "projects.json"), JSON.stringify([
        { id: "native-traversal", path: project, name: "Native traversal", environment: "windows" },
      ]));
      parent = writeSessionFile(directory.sessions, project, "parent");
      mkdirSync(parent.slice(0, -6));
      child = writeSessionFile(parent.slice(0, -6), project, "child");
      const deep = join(directory.sessions, "deep");
      mkdirSync(deep);
      const link = join(directory.root, "runtime-link");
      directoryLink(deep, link);
      // String concatenation keeps the POSIX traversal that path.join would erase.
      runtimePath = `${link}/../parent/child.jsonl`;
      const sessions = [["parent", parent], ["child", runtimePath]]
        .map(([id, filePath]) => ({ id, filePath, projectId: "native-traversal", title: id,
          environment: "native", source: "pi", originKey: `traversal-${id}`, status: "active", createdAt: 1, updatedAt: 1 }));
      writeFileSync(join(directory.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions }));
      const fake = createFakePi(directory, {});
      return { settings: { customPiPath: fake.shim }, env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath } };
    },
  });
  const original = readFileSync(child, "utf8");
  assert.equal(readFileSync(runtimePath, "utf8"), original);
  const activation = await f.invoke("sessions:runtime-activate", ["child"]);
  assert.equal(activation.payload.result.ok, true, JSON.stringify(activation.payload));
  assert.equal(activation.payload.result.value.sessionPath, runtimePath);
  const deletion = await f.invoke("sessions:catalog-delete", ["parent", { permanent: true }]);
  assert.equal(deletion.payload.ok, false, JSON.stringify(deletion.payload));
  assert.equal(readFileSync(child, "utf8"), original);
  assert.ok(existsSync(parent));
});
