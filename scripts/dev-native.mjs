import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Preserve argument boundaries and propagate startup/build failures to the caller. */
function runCommand(command, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

/** Build and launch the same native stage with an isolated development profile. */
export async function runNativeDev({
  repoRoot = fileURLToPath(new URL("../", import.meta.url)),
  platform = process.platform,
  nodeExecutable = process.execPath,
  environment = process.env,
  run = runCommand,
} = {}) {
  const root = resolve(repoRoot);
  const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (typeof packageVersion !== "string" || !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(packageVersion)) {
    throw new Error(`Invalid package version: ${String(packageVersion)}`);
  }
  // Windows cannot execute npm.cmd through spawn without a shell. Use the JS CLI
  // through Node, as the release builder does, preserving paths containing spaces.
  const npmCommand = platform === "win32" ? nodeExecutable : "npm";
  const npmPrefix = platform === "win32"
    ? [environment.npm_execpath ?? join(dirname(nodeExecutable), "node_modules", "npm", "bin", "npm-cli.js")]
    : [];
  const xmakeCommand = platform === "win32" ? "xmake.exe" : "xmake";
  const stage = resolve(root, environment.PIDECK_STAGE_DIR?.trim() || "release/win-unpacked");
  const options = { cwd: root, env: { ...environment, PIDECK_VERSION: packageVersion, PIDECK_STAGE_DIR: stage } };
  await run(npmCommand, [...npmPrefix, "run", "build:renderer"], options);
  await run(npmCommand, [...npmPrefix, "run", "build:webfetch"], options);
  await run(xmakeCommand, ["f", "-m", "debug", "-y"], options);
  await run(xmakeCommand, ["-r"], options);

  const executable = join(stage, platform === "win32" ? "PiDeck-Q.exe" : "PiDeck-Q");
  if (!existsSync(executable)) throw new Error(`Native debug executable was not found: ${executable}`);
  const appData = environment.APPDATA ?? join(homedir(), "AppData", "Roaming");
  const userData = environment.PIDECK_DEV_USER_DATA ?? join(appData, "pi-desktop-dev");
  await run(executable, [], {
    cwd: root,
    env: {
      ...environment,
      PIDECK_PACKAGED: "0",
      PIDECK_USER_DATA: userData,
      PIDECK_VERSION: `${packageVersion}-dev`,
      PIDECK_APP_USER_MODEL_ID: "com.ayuayue.pi-desktop-dev",
      PIDECK_TOAST_SHORTCUT_NAME: "PiDeck-Q Dev.lnk",
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runNativeDev().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
