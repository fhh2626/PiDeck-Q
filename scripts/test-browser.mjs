import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Reject interactive overrides before Playwright can start a browser or inspector. */
export function browserTestPlan(args = [], environment = process.env) {
  if (args.some((value) => /^--(?:headed|debug|ui(?:-host|-port)?|config)(?:=|$)/.test(value) || /^-c/.test(value))
    || (environment.PWDEBUG && environment.PWDEBUG !== "0")) {
    throw new Error("Browser tests are unattended. Headed, debug, UI modes and config overrides are disabled; use code assertions and saved traces instead.");
  }
  return {
    command: process.execPath,
    args: [require.resolve("@playwright/test/cli"), "test", "--config", "tests/browser/playwright.config.ts", ...args],
    options: { stdio: "inherit", windowsHide: true, env: { ...environment, PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" } },
  };
}

/** Propagate failures and exit codes without a shell or visible console. */
export function runBrowserTests(args = process.argv.slice(2)) {
  const plan = browserTestPlan(args);
  return new Promise((resolveRun, reject) => {
    const child = spawn(plan.command, plan.args, plan.options);
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolveRun() : reject(new Error(`Browser tests exited with ${code ?? signal}`)));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runBrowserTests().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
