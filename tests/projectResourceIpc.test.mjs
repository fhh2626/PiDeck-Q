import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const entry = readFileSync("src/main/index.ts", "utf8");
const projectsIpc = readFileSync("src/main/ipc/projectsIpc.ts", "utf8");
const projectResourceIpc = readFileSync("src/main/ipc/projectResourceIpc.ts", "utf8");

test("project resource IPC is registered through one-way dependencies", () => {
  assert.match(projectsIpc, /registerProjectResourceIpc\(router,\s*\{[\s\S]*appLogger,[\s\S]*projectResourceManager,[\s\S]*\}\)/);
  assert.doesNotMatch(projectsIpc, /ipcChannels\.projectResources/);
  assert.doesNotMatch(projectResourceIpc, /from\s+["']\.\.\/index["']/);
});

test("project resource IPC retains all handlers and manager-owned path checks", () => {
  for (const channel of [
    "projectResourcesList",
    "projectResourcesCreateSkill",
    "projectResourcesDeleteSkill",
    "projectResourcesDeleteExtension",
    "projectResourcesToggleSkill",
    "projectResourcesToggleExtension",
    "projectResourcesRenameSkill",
  ]) {
    assert.match(projectResourceIpc, new RegExp(`ipcChannels\\.${channel}`));
  }
  assert.match(projectResourceIpc, /projectResourceManager\.deleteSkill\(projectId, skillPath\)/);
  assert.match(projectResourceIpc, /projectResourceManager\.deleteExtension\(projectId, extensionPath\)/);
  assert.match(projectResourceIpc, /rechecks project ownership/);
});
