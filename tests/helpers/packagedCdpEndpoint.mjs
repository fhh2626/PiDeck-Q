import { existsSync, readFileSync } from "node:fs";
import { ISOLATION_QUEUE_TIMEOUT_MS } from "./isolatedDesktop.mjs";

/** Parse Chromium's endpoint from this launch's private profile, not a free-port guess. */
export function readDebugEndpoint(path) {
  if (!path || !existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  if (text.length > 16384) throw new Error("Invalid private CDP endpoint file");
  const fields = text.trim().split(/\r?\n/);
  if (fields.length < 2) return null;
  const port = Number(fields[0]);
  if (fields.length !== 2 || !Number.isInteger(port) || port <= 0 || port > 65535
    || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(fields[1]))
    throw new Error("Invalid private CDP endpoint file");
  return { port, browserPath: fields[1] };
}

/** Only this fixture's loopback endpoint may receive CDP commands. */
function validateTarget(value, endpoint, expectedPath) {
  const url = new URL(value);
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash
    || Number(url.port) !== endpoint.port || (expectedPath ? url.pathname !== expectedPath : !url.pathname.startsWith("/devtools/page/")))
    throw new Error("CDP endpoint ownership mismatch");
}

/** Bind discovery to Chromium's private-profile browser ID before connecting to a page. */
export async function connectFixturePage(_legacyPort, { timeoutMs = 120000, launch, connectClient, now = Date.now }) {
  if (launch?.admitted) {
    let timer;
    try {
      const accepted = await Promise.race([launch.admitted, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Isolated desktop admission timed out")), ISOLATION_QUEUE_TIMEOUT_MS);
      })]);
      if (!accepted) throw new Error(`packaged host exited before isolation admission: ${JSON.stringify(launch.output)}`);
    } finally { clearTimeout(timer); }
  }
  // A healthy earlier GUI job may own the station. Its queue time is not this
  // host's WebView2 boot time, and must not consume the renderer startup budget.
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (launch && (launch.child.exitCode !== null || launch.child.signalCode || launch.output.error))
      throw new Error(`packaged host exited before WebView2 was ready: ${JSON.stringify({ code: launch.child.exitCode, signal: launch.child.signalCode, ...launch.output })}`);
    const endpoint = readDebugEndpoint(launch?.debugPortFile);
    if (endpoint) {
      const options = () => ({ signal: AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - now()))) });
      let version;
      try {
        const response = await fetch(`http://127.0.0.1:${endpoint.port}/json/version`, options());
        version = await response.json();
      } catch {
        // A newly written port file can precede the HTTP listener becoming ready.
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        continue;
      }
      validateTarget(version.webSocketDebuggerUrl, endpoint, endpoint.browserPath);
      let targets;
      try {
        const response = await fetch(`http://127.0.0.1:${endpoint.port}/json/list`, options());
        targets = await response.json();
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        continue;
      }
      const page = targets.find((target) => target.type === "page");
      if (page) {
        // Ownership failures must never be retried as transient startup errors.
        validateTarget(page.webSocketDebuggerUrl, endpoint);
        try {
          return { cdp: await connectClient(page.webSocketDebuggerUrl, {
            timeoutMs: Math.min(5000, Math.max(1, deadline - now())),
          }), target: page };
        } catch {
          // A page target may be advertised before its socket accepts connections.
        }
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`the packaged host never exposed its private CDP endpoint: ${JSON.stringify(launch?.output ?? {})}`);
}
