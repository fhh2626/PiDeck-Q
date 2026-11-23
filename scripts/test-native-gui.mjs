import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { childPathEnvironment, environmentPath, qtBinDirectory } from "../tests/helpers/native2BackendHarness.mjs";
import { joinPathParts } from "../tests/helpers/native2FakeProcess.mjs";
import { isolatedDesktopCommand } from "../tests/helpers/isolatedDesktop.mjs";

/** Keep real HWND/WebView2 coverage on a noninteractive desktop, with no manual steps. */
export async function runNativeGuiGate() {
  const environment = { ...process.env };
  environment.QT_QPA_PLATFORM = process.platform === "win32" ? "windows" : "offscreen";
  const env = childPathEnvironment(environment, joinPathParts([qtBinDirectory(), environmentPath(environment)]));
  const xmake = process.platform === "win32" ? "xmake.exe" : "xmake";
  function run(command, args) {
    return new Promise((resolveRun, reject) => {
      const child = spawn(command, args, { stdio: "inherit", env, windowsHide: true });
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code ?? signal}`)));
    });
  }
  await run(xmake, ["f", "-m", "debug", "-y"]);
  if (process.platform === "win32") await run(xmake, ["build", "-y", "PiDeck-IsolatedDesktop"]);
  await run(xmake, ["build", "-y", "PiDeck-NativeGuiTest"]);
  if (process.platform === "win32") {
    const target = resolve("build/windows/x64/debug/PiDeck-NativeGuiTest.exe");
    const isolated = isolatedDesktopCommand(target);
    await run(isolated.command, isolated.args);
  } else {
    await run(xmake, ["run", "PiDeck-NativeGuiTest"]);
  }
  console.log("Native GUI integration test passed without interactive-desktop windows.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runNativeGuiGate().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
