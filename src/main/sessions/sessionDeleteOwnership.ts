import { isSubagentRunDirectoryName } from "./sessionDeleteResidue";

/** Only producer-defined tool-result identity fields are ownership evidence, never output prose. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** Portable producer IDs only: rejecting paths prevents result data from escaping the shared root. */
function safeIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length <= 255
    && /^[A-Za-z0-9_%~.!()'-]+$/.test(value) && value !== "." && value !== ".."
    && !value.endsWith(".") && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

/** Mirrors the bundled producer's sanitizeRunPathSegment for managed output directories. */
function outputIdentity(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return Buffer.byteLength(sanitized, "utf8") > 120 ? sanitized.slice(0, 120).replace(/_+$/, "") : sanitized;
}

/** Identity aliases are bounded and must never authorize an external artifact path. */
function addIdentity(ids: Set<string>, value: unknown): void {
  if (!safeIdentity(value)) return;
  ids.add(value);
  const output = outputIdentity(value);
  if (output) ids.add(output);
}

/** Extract foreground, workflow, async and resumed IDs from persisted subagent results. */
export function collectSessionRunIdentities(raw: string): Set<string> {
  const ids = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const entry = record(parsed);
    const message = record(entry?.message);
    if (entry?.type !== "message" || message?.role !== "toolResult" || message.toolName !== "subagent") continue;
    const details = record(message.details);
    if (!details || typeof details.mode !== "string" || !["single", "workflow", "parallel", "chain"].includes(details.mode)) continue;
    // Only known identity envelopes are visited: workflow.value, text, prompts and paths are not evidence.
    const queue: unknown[] = [details];
    for (let index = 0; index < queue.length; index += 1) {
      const item = record(queue[index]);
      if (!item) continue;
      addIdentity(ids, item.runId);
      addIdentity(ids, item.asyncId);
      addIdentity(ids, item.workflowRunId);
      for (const key of ["results", "children"]) {
        const children = item[key];
        if (Array.isArray(children)) {
          if (queue.length + children.length > 10000) throw new Error("Session deletion identity entry limit exceeded");
          queue.push(...children);
        }
      }
      const summary = record(item.workflowChildren);
      if (summary) queue.push(summary);
      if (queue.length > 10000 || ids.size > 10000) throw new Error("Session deletion identity entry limit exceeded");
    }
  }
  return ids;
}

/** UUID directories remain a compatibility fallback when older results have no identity metadata. */
export function collectDirectoryRunIdentities(names: readonly string[]): Set<string> {
  return new Set(names.filter(isSubagentRunDirectoryName));
}
