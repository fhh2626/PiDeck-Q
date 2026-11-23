import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const timeline = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");
const webApp = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
const sessionAtoms = readFileSync("src/renderer/src/atoms/session-atoms.ts", "utf8");

test("deleted sessions invalidate the desktop timeline and web message cache", () => {
  assert.match(timeline, /sessionMessageLoadStateBySessionIdAtomFamily\(options\.sessionId\)/);
  assert.doesNotMatch(timeline, /useAtomValue\(\s*sessionMessageLoadStateAtom\s*\)/);
  assert.match(timeline, /previouslyLoaded && currentStatus === "error"/);
  assert.match(timeline, /previouslyLoaded && currentStatus === "loading"/);
  assert.match(webApp, /delete messagesBySessionRef\.current\[id\]/);
});

test("message load state is isolated per session like the message cache", () => {
  assert.match(sessionAtoms, /export const sessionMessageLoadStateBySessionIdAtomFamily/);
  assert.match(sessionAtoms, /sessionMessageLoadStateBySessionIdAtomFamily\.remove\(sessionId\)/);
});
