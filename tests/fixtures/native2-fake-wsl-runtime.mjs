import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

/** A stdio-only pi substitute for isolated WSL ownership and admission regressions. */
export function runFakeWslRuntime(scenario, argv, logPath) {
  process.stdout._handle?.setBlocking?.(true);
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    if (logPath) appendFileSync(logPath, `${JSON.stringify({ rpc: request.type, argv })}\n`);
    const data = request.type === "get_messages" ? { messages: [] }
      : request.type === "get_state" ? { thinkingLevel: "off", ...(scenario.runtimeReportedPath ? { sessionFile: scenario.runtimeReportedPath } : {}) }
      : ["fork", "clone"].includes(request.type) ? { cancelled: true } : {};
    const delay = request.type === "get_state" ? Number(scenario.runtimeStateDelayMs ?? 0)
      : request.type === "get_messages" ? Number(scenario.runtimeProjectionDelayMs ?? 0)
      : ["fork", "clone"].includes(request.type) ? Number(scenario.runtimeReplacementDelayMs ?? 0) : 0;
    setTimeout(() => process.stdout.write(`${JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data })}\n`), delay);
  });
}
