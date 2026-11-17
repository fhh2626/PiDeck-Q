import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

// Pre-upgrade catalogs have no trusted historical-root provenance. Recovery must
// require a real settings change, never derive deletion authority from the catalog.
if (resolveBackendExecutable()) {
  for (const language of ["en-US", "zh-CN"]) {
    test(`legacy root has actionable ${language} recovery without silently authorizing its catalog path`, async (t) => {
      let file, originalRoot, currentRoot, settingsFile, sentinel;
      const f = await startBackendSession(t, {
        settings: { language },
        prepare: (fixture) => {
          const project = join(fixture.root, "project");
          originalRoot = join(fixture.root, "former-sessions");
          currentRoot = join(fixture.root, "current-sessions");
          mkdirSync(join(project, ".pi"), { recursive: true });
          mkdirSync(originalRoot); mkdirSync(currentRoot);
          settingsFile = join(project, ".pi", "settings.json");
          writeFileSync(settingsFile, JSON.stringify({ sessionDir: currentRoot }));
          file = join(originalRoot, "legacy.jsonl");
          writeFileSync(file, [
            { type: "session", version: 3, id: "legacy", cwd: project, timestamp: "2026-01-01T00:00:00.000Z" },
            { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "Legacy session" }] } },
          ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
          sentinel = join(currentRoot, "keep.txt"); writeFileSync(sentinel, "unrelated");
          writeFileSync(join(fixture.userData, "projects.json"), JSON.stringify([
            { id: "legacy-project", path: project, name: "Legacy project", environment: "windows" },
          ]));
          writeFileSync(join(fixture.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions: [
            { id: "legacy", projectId: "legacy-project", environment: "native", source: "pi", status: "active",
              title: "Legacy session", filePath: file, originKey: `pi:native:${file.replaceAll("\\", "/").toLowerCase()}` },
          ] }));
        },
      });
      const refused = await f.invoke("sessions:catalog-delete", ["legacy", { permanent: true }]);
      assert.equal(refused.payload.ok, false, JSON.stringify(refused.payload));
      assert.match(refused.payload.error.message, /sessionDir/);
      assert.match(refused.payload.error.message, language === "zh-CN" ? /刷新/ : /refresh/i);
      assert.equal(f.trashCalls.length, 0);
      assert.ok(existsSync(file));
      // User-controlled project settings are the authority. Refresh explicitly
      // verifies the restored root and persists its provenance for future retries.
      writeFileSync(settingsFile, JSON.stringify({ sessionDir: originalRoot }));
      const refreshed = await f.invoke("sessions:catalog-list", ["legacy-project"]);
      assert.equal(refreshed.payload.ok, true, JSON.stringify(refreshed.payload));
      assert.ok(refreshed.payload.result.some((entry) => entry.id === "legacy"));
      writeFileSync(settingsFile, JSON.stringify({ sessionDir: currentRoot }));
      const deleted = await f.invoke("sessions:catalog-delete", ["legacy", { permanent: true }]);
      assert.equal(deleted.payload.result, true, JSON.stringify(deleted.payload));
      assert.equal(existsSync(file), false);
      assert.equal(readFileSync(sentinel, "utf8"), "unrelated");
    });
  }
}
