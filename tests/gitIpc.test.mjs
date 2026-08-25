import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const entry = readFileSync("src/native-node/index.ts", "utf8");const registerBackendRpc = readFileSync("src/main/backend/registerBackendRpc.ts", "utf8");
const gitIpc = readFileSync("src/main/ipc/gitIpc.ts", "utf8");

test("Git IPC is registered through one-way service dependencies", () => {
  assert.match(registerBackendRpc, /registerGitIpc\(router,\s*\{[\s\S]*appLogger,[\s\S]*gitService,[\s\S]*piLocator,[\s\S]*projectStore,[\s\S]*settingsStore,[\s\S]*worktreeService,[\s\S]*\}\)/);
  assert.doesNotMatch(entry, /ipcMain\.handle\(ipcChannels\.git/);
  assert.doesNotMatch(gitIpc, /from\s+["']\.\.\/index["']/);
});

test("Git IPC keeps project lookup, bounded diffs, and stale-worktree cleanup", () => {
  for (const channel of [
    "gitBranches",
    "gitCheckout",
    "gitCreateBranch",
    "gitOriginalContent",
    "gitWorktreeList",
    "gitWorktreeCreate",
    "gitWorktreeRemove",
    "gitCommitLog",
    "gitRefs",
    "gitBranchCompare",
    "gitCommitDetail",
    "gitCommitFileDiff",
    "gitDiffFileBetween",
    "gitStatus",
    "gitWorkspaceFileDiff",
    "gitStage",
    "gitUnstage",
    "gitDiscard",
    "gitCommit",
    "gitCherryPick",
    "gitRevert",
    "gitPush",
    "gitPull",
    "gitReset",
    "gitDropCommit",
    "gitGenerateCommitMessage",
    "gitInit",
    "gitFetch",
    "gitAheadBehind",
    "gitDeleteFiles",
  ]) {
    assert.match(gitIpc, new RegExp(`ipcChannels\\.${channel}`));
  }
  assert.match(gitIpc, /maxEditorFileSizeMB/);
  assert.match(gitIpc, /const stillInGit = \(await worktreeService\.list\(project\.path\)\)\.some/);
  assert.match(gitIpc, /if \(ok \|\| !stillInGit\)/);
  assert.match(gitIpc, /projectStore\.remove\(child\.id\)/);
});
