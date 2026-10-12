import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/** A disposable, deterministic history with full UTF-8 messages and real production trimming. */
export async function withHistoryFixture(mebibytes, run, options = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), "pideck-perf-history-"));
  const path = join(directory, "session.jsonl");
  const body = "正文😀".repeat(1024);
  const rows = [JSON.stringify({ type: "session", id: "root" })];
  let bytes = Buffer.byteLength(rows[0]) + 1;
  let count = 0;
  while (bytes < mebibytes * 1024 * 1024) {
    const row = JSON.stringify({ type: "message", id: `e${count}`, parentId: count ? `e${count - 1}` : "root",
      message: { id: `m${count}`, role: count % 6 === 0 ? "user" : "assistant", content: body } });
    rows.push(row); bytes += Buffer.byteLength(row) + 1; count++;
  }
  const metrics = { bytes: 0, fullReads: 0, opens: 0 };
  const tracedFs = {
    ...fs,
    async stat(...args) {
      if (String(args[0]) === path && options.statPath) args[0] = options.statPath(path);
      return fs.stat(...args);
    },
    async readFile(...args) {
      const value = await fs.readFile(...args);
      if (String(args[0]) === path) { metrics.bytes += Buffer.byteLength(value); metrics.fullReads++; }
      return value;
    },
    async open(...args) {
      const handle = await fs.open(...args);
      if (String(args[0]) !== path) return handle;
      metrics.opens++;
      return new Proxy(handle, { get(target, key) {
        if (key === "read") return async (...params) => {
          await options.beforeRead?.();
          if (options.maxReadBytes !== undefined) params[2] = Math.min(params[2], options.maxReadBytes);
          const result = await target.read(...params); metrics.bytes += result.bytesRead; return result;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    },
  };
  const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts", {
    stubs: { "node:fs/promises": tracedFs },
  });
  const { trimHistoryMessages } = loadTsCommonJs("src/main/pi/agentUtils.ts");
  const reader = new SessionHistoryReader({ toHostPath: (p) => p, trimMessages: trimHistoryMessages,
    convertMessages: (_id, messages, ids = []) => messages.map((m, i) => ({ id: ids[i] ?? `m${i}`, role: m.role, text: m.content })),
    translate: () => "fixture" });
  try {
    await fs.writeFile(path, rows.join("\n") + "\n", "utf8");
    return await run({ reader, path, metrics, fileBytes: bytes, count, body });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

/** Resource-only Buffer facade: records copying without mutating Node's global Buffer. */
export function copyingBuffer(metrics) {
  return new Proxy(Buffer, { get(target, key) {
    if (key === "concat") return (parts, ...args) => {
      metrics.copied += parts.reduce((sum, part) => sum + part.length, 0);
      return Buffer.concat(parts, ...args);
    };
    if (key === "alloc" || key === "allocUnsafe") return (...args) => {
      const buffer = target[key](...args);
      const set = buffer.set.bind(buffer);
      buffer.set = (source, offset) => { metrics.copied += source.length; set(source, offset); };
      return buffer;
    };
    return Reflect.get(target, key);
  } });
}
