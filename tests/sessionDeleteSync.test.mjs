import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const main = readFileSync("src/main/index.ts", "utf8");
const createBackend = readFileSync("src/main/backend/createBackend.ts", "utf8");
const sessionBridge = readFileSync("src/main/backend/sessionRuntimeBridge.ts", "utf8");
const sessionIpc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
const projectsIpc = readFileSync("src/main/ipc/projectsIpc.ts", "utf8");
const timeline = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");
const chrome = readFileSync("src/renderer/src/hooks/useSessionWorkspaceChrome.ts", "utf8");
const webApp = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
const sessionAtoms = readFileSync("src/renderer/src/atoms/session-atoms.ts", "utf8");

test("web session mutations notify the desktop catalog instead of leaving PC stale", () => {
  assert.match(
    createBackend,
    /deleteSessionRecord: async \(sessionId\)[\s\S]*sessionsCatalogRefreshed[\s\S]*projectId/,
  );
  assert.match(
    createBackend,
    /createSessionDraft: async \(input\)[\s\S]*sessionsCatalogRefreshed[\s\S]*projectId: input\.projectId/,
  );
  assert.match(
    sessionBridge,
    /void activateAnonymousRuntime\(session, project, input\)[\s\S]*sessionsCatalogRefreshed[\s\S]*projectId: session\.projectId/,
  );
  assert.match(
    sessionIpc,
    /sessionsCatalogDelete[\s\S]*sessionsCatalogRefreshed[\s\S]*projectId: entry\.projectId/,
  );
});

test("web project deletion broadcasts the same visible project list as desktop IPC", () => {
  assert.match(projectsIpc, /export function listVisibleProjects\(/);
  assert.match(
    createBackend,
    /deleteProject: async \(projectId\)[\s\S]*projectsChanged[\s\S]*listVisibleProjects\(projectStore, settingsStore\)/,
  );
  assert.doesNotMatch(
    createBackend,
    /deleteProject: async \(projectId\)[\s\S]*kind !== "chat"/,
  );
});

test("deleted current session leaves the desktop timeline and focuses a surviving tab", () => {
  assert.match(timeline, /sessionMessageLoadStateBySessionIdAtomFamily\(options\.sessionId\)/);
  assert.doesNotMatch(timeline, /useAtomValue\(\s*sessionMessageLoadStateAtom\s*\)/);
  assert.match(timeline, /previouslyLoaded && currentStatus === "error"/);
  assert.match(timeline, /previouslyLoaded && currentStatus === "loading"/);
  assert.match(chrome, /snap\.currentSessionId && !sessionRecords\[snap\.currentSessionId\]/);
  assert.match(chrome, /remaining\[Math\.min\(deletedIndex, remaining\.length - 1\)\]/);
  assert.match(webApp, /delete messagesBySessionRef\.current\[id\]/);
});

test("message load state is isolated per session like the message cache", () => {
  assert.match(sessionAtoms, /export const sessionMessageLoadStateBySessionIdAtomFamily/);
  assert.match(sessionAtoms, /sessionMessageLoadStateBySessionIdAtomFamily\.remove\(sessionId\)/);
});
