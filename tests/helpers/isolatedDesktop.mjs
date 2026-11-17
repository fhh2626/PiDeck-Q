import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { nativeBuildPaths } from "./nativeBuildPaths.mjs";

/** Admission and target boot have separate bounded deadlines. */
export const ISOLATION_QUEUE_TIMEOUT_MS = 195_000;
export const ISOLATION_SELF_TEST_TIMEOUT_MS = 210_000;

/** Real native UI tests must never fall back to the interactive desktop. */
export function isolatedDesktopCommand(executable, args = [], environment = process.env) {
  if (process.platform !== "win32") throw new Error("Native UI isolation currently requires Windows; interactive-desktop fallback is disabled on this platform.");
  const source = resolve("native/tests/IsolatedDesktopLauncher.cpp");
  const candidates = nativeBuildPaths("PiDeck-IsolatedDesktop", { pinned: environment.PIDECK_ISOLATED_DESKTOP_EXECUTABLE });
  const launcher = candidates.map((path) => resolve(path)).find((path) => existsSync(path)
    && statSync(path).mtimeMs >= statSync(source).mtimeMs);
  if (!launcher) throw new Error("A fresh PiDeck-IsolatedDesktop launcher is required. Run xmake build -y PiDeck-IsolatedDesktop; interactive-desktop fallback is disabled.");
  return { command: launcher, args: [resolve(executable), ...args] };
}
