import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** Run production assembly with real persisted catalogs and inert external services. */
async function startupFixture(t, { unavailableChat = false, duplicate = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pideck-review-startup-"));
  let backend;
  t.after(async () => {
    await backend?.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, "project"); await mkdir(project);
  await writeFile(join(root, "projects.json"), JSON.stringify([{ id: "p", name: "p", path: project, environment: "windows", lastOpenedAt: 1 }]));
  if (unavailableChat) {
    // A destination which used to be a directory can become unavailable without
    // invalidating the readable ordinary projects/catalog files.
    await writeFile(join(root, "offline-chat"), "not a directory");
    await writeFile(join(root, "chat-path.json"), JSON.stringify({ path: join(root, "offline-chat") }));
  }
  const { buildSessionOriginKey } = loadTsCommonJs("src/shared/sessionIdentity.ts");
  const relativePath = ".pi/sessions/old.jsonl";
  const entry = (id, filePath, createdAt) => ({
    id, projectId: "p", title: "old", source: "pi", environment: "native", filePath,
    originKey: buildSessionOriginKey({ source: "pi", environment: "native", filePath }),
    status: "active", createdAt, updatedAt: createdAt,
  });
  const sessions = [entry("stable-id", relativePath, 1)];
  if (duplicate) sessions.push(entry("duplicate-id", join(project, relativePath), 2));
  await writeFile(join(root, "session-catalog.json"), JSON.stringify({ version: 1, sessions }));
  const warnings = [];
  class InertService {
    info() {} warn(domain, message, details) { warnings.push({ domain, message, details }); }
    error() {} onOutput() {} closeAll() {} stopAll() {} async stop() {}
  }
  const stubs = {};
  for (const [module, name] of [
    ["../fs/FileSystemService", "FileSystemService"], ["../sessions/SessionScanner", "SessionScanner"],
    ["../sessions/SessionRuntimeCoordinator", "SessionRuntimeCoordinator"],
    ["../sessions/CodexSessionImporter", "CodexSessionImporter"], ["../sessions/ClaudeSessionImporter", "ClaudeSessionImporter"],
    ["../sessions/OpenCodeSessionImporter", "OpenCodeSessionImporter"], ["../security/SecurityStore", "SecurityStore"],
    ["../git/GitService", "GitService"], ["../git/WorktreeService", "WorktreeService"], ["../config/ConfigManager", "ConfigManager"],
    ["../terminal/TerminalSessionManager", "TerminalSessionManager"], ["../prompts/PromptManager", "PromptManager"],
    ["../prompts/XuePromptManager", "XuePromptManager"], ["../skills/SkillManager", "SkillManager"],
    ["../extensions/ExtensionManager", "ExtensionManager"], ["../projects/ProjectResourceManager", "ProjectResourceManager"],
    ["../logging/AppLogger", "AppLogger"], ["../logging/RpcLogger", "RpcLogger"], ["../usageStats/UsageStatsService", "UsageStatsService"],
    ["../pi/PiLocator", "PiLocator"], ["../pi/AgentManager", "AgentManager"], ["../pi/modelSpecsStore", "ModelSpecsStore"],
    ["../settings/visionBridgeConfig", "VisionBridgeConfigManager"], ["../web/WebServiceManager", "WebServiceManager"],
    ["../sessions/SessionRecordService", "SessionRecordService"],
  ]) stubs[module] = { [name]: InertService };
  const logger = new InertService();
  stubs["../logging/sharedLogger"] = { setAppLogger() {}, getAppLogger: () => logger };
  stubs["../settings/DesktopProxy"] = { applyDesktopProxy: async () => {} };
  stubs["../pi/modelListCache"] = { fetchModelList: async () => [], refreshModelList: async () => {} };
  stubs["../ipc/projectsIpc"] = { listVisibleProjects: store => store.list() };
  stubs["./sessionRuntimeBridge"] = { createSessionRuntimeBridge: () => ({}) };
  let scan;
  stubs["./registerBackendRpc"] = { registerBackendRpc: ({ services }) => {
    scan = () => services.sessionCatalog.mergeScanned("p", [{ filePath: join(project, relativePath), name: "old", source: "pi", updatedAt: 2, projectPath: project, preview: "", messageCount: 1 }]);
    return () => {};
  } };
  // Startup effects are external to these tests; never re-load projects here.
  stubs["./backendStartupTasks"] = { startBackendStartupTasks() {} };
  const { createBackend } = loadTsCommonJs("src/main/backend/createBackend.ts", { stubs });
  backend = await createBackend({
    router: {}, host: { sendToRenderer() {} },
    platform: {
      paths: { home: root, userData: root, appPath: root, resourcesPath: root, downloads: root },
      application: { hideApplicationMenu() {}, getLocale: () => "en-US", name: "test", version: "0.4.0", isPackaged: false },
      shell: { trashItem: async () => {} },
    },
  });
  return { root, project, relativePath, scan, warnings };
}

test("backend startup repairs relative session identities before the first scan", async t => {
  const fixture = await startupFixture(t);
  const records = await fixture.scan();
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "stable-id");
  assert.equal(records[0].filePath, join(fixture.project, fixture.relativePath));
});

test("unavailable custom chat directory does not prevent backend startup or catalog migration", async t => {
  const fixture = await startupFixture(t, { unavailableChat: true });
  const records = await fixture.scan();
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "stable-id");
  assert.equal(records[0].filePath, join(fixture.project, fixture.relativePath));
  assert.ok(fixture.warnings.some(warning => warning.domain === "projects" && warning.details.cause.includes("not a directory")));
});

test("backend startup consolidates already persisted relative and absolute duplicates", async t => {
  const fixture = await startupFixture(t, { duplicate: true });
  const records = await fixture.scan();
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "stable-id");
  assert.equal(records[0].filePath, join(fixture.project, fixture.relativePath));
});
