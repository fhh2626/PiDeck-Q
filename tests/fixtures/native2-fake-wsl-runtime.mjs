import { createInterface } from "node:readline";
import { appendFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

/** Hold a fixture boundary until the test explicitly releases it, with bounded teardown. */
export async function waitForFakeWslGate(path) {
  if (!path) return;
  const deadline = Date.now() + 10_000;
  while (!existsSync(path) && Date.now() < deadline) await delay(10);
  if (!existsSync(path)) throw new Error("fake WSL fixture gate timed out");
}

/** A stdio-only pi substitute for isolated WSL ownership and admission regressions. */
export function runFakeWslRuntime(scenario, argv, logPath) {
  process.stdout._handle?.setBlocking?.(true);
  const lines = createInterface({ input: process.stdin });
  const reconnecting = scenario.runtimeExitGate && existsSync(scenario.runtimeExitGate);
  if (scenario.runtimeExitGate && !reconnecting) {
    const timer = setInterval(() => {
      if (existsSync(scenario.runtimeExitGate)) process.exit(0);
    }, 10);
    timer.unref();
  }
  lines.on("line", async (line) => {
    const request = JSON.parse(line);
    if (logPath) appendFileSync(logPath, `${JSON.stringify({ rpc: request.type, argv })}\n`);
    const data = request.type === "get_messages" ? { messages: [] }
      : request.type === "get_state" ? { thinkingLevel: "off", ...(scenario.runtimeReportedPath ? { sessionFile: scenario.runtimeReportedPath } : {}) }
      : ["fork", "clone"].includes(request.type) ? { cancelled: true } : {};
    try {
      const gate = reconnecting ? scenario.reconnectReplyGates?.[request.type] : scenario.runtimeReplyGates?.[request.type];
      if (gate) await waitForFakeWslGate(gate);
      process.stdout.write(`${JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data })}\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    }
  });
}
