import type { SessionFileVersion } from "./sessionSummaryCache";

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_ARGUMENT_BYTES = 12 * 1024;
const METADATA_FILES = 64;
const BODY_FILES = 16;
// Paths are positional arguments, never interpolated into shell code. JSONL cannot contain
// literal NUL in valid JSON; malformed framing falls back to isolated, budgeted cat reads.
const READ_FILES_SCRIPT = 'for file do printf "%s\\0" "$file"; cat -- "$file"; status=$?; printf "\\0%s\\0" "$status"; done';

type ExecuteRead = (args: string[], timeout: number, maxBuffer: number, signal?: AbortSignal) => Promise<string>;
export type WslScanBodyRead = { status: "not-requested" } | { status: "failed" } | { status: "success"; text: string };
export type WslScanFileRead = { version: SessionFileVersion; body: WslScanBodyRead };

/** Keep partial stdout at the internal command boundary; never log transcript content.
 * execFile reports a timeout as killed/SIGTERM (or ETIMEDOUT in platform substitutes). */
export class WslScanCommandError extends Error {
  readonly timedOut: boolean;
  constructor(readonly stdout: string, cause: unknown) {
    super("WSL scan read failed", { cause });
    this.timedOut = cause !== null && typeof cause === "object" &&
      (Reflect.get(cause, "code") === "ETIMEDOUT" ||
        (Reflect.get(cause, "killed") === true && Reflect.get(cause, "signal") === "SIGTERM"));
  }
}

/** Validate the ordered envelope before accepting bodies, including a timeout's complete prefix.
 * A partial path/body identifies the in-progress file: do not restart that same stalled cat. */
function parseBodies(output: string, paths: string[], partial: boolean): { bodies: Map<string, WslScanBodyRead>; pending: string[] } | undefined {
  const fields = output.split("\0"), bodies = new Map<string, WslScanBodyRead>();
  let index = 0;
  while (index < paths.length && fields.length >= index * 3 + 4) {
    const from = index * 3;
    if (fields[from] !== paths[index] || !/^\d+$/.test(fields[from + 2])) return undefined;
    const text = fields[from + 1];
    bodies.set(paths[index], fields[from + 2] === "0" && Buffer.byteLength(text) <= MAX_BODY_BYTES
      ? { status: "success", text } : { status: "failed" });
    index++;
  }
  const tail = fields.slice(index * 3);
  if (index === paths.length) {
    return tail.length === 1 && tail[0] === "" ? { bodies, pending: [] } : undefined;
  }
  if (!partial) return undefined;
  // A completed record boundary is also unambiguous: the next cat has not printed its header.
  if (index > 0 && tail.length === 1 && tail[0] === "") return { bodies, pending: paths.slice(index) };
  // Only a terminated path header is evidence that this file was attempted. A cut header
  // or malformed NUL data is ambiguous, so callers conservatively skip timeout recovery.
  if (tail.length !== 2 || tail[0] !== paths[index]) return undefined;
  bodies.set(paths[index], { status: "failed" });
  return { bodies, pending: paths.slice(index + 1) };
}

/** Bound argument length and aggregate body bytes without reducing the per-file 64 MiB budget. */
function groupPaths(paths: readonly string[], limit: number, versions?: ReadonlyMap<string, SessionFileVersion>): string[][] {
  const groups: string[][] = [];
  let group: string[] = [], argumentsBytes = 0, bodyBytes = 0;
  for (const path of paths) {
    const bytes = Buffer.byteLength(path) + 1;
    const size = versions ? (versions.get(path)?.size ?? MAX_BODY_BYTES) : 0;
    if (group.length && (group.length >= limit || argumentsBytes + bytes > MAX_ARGUMENT_BYTES || bodyBytes + size > MAX_BODY_BYTES)) {
      groups.push(group); group = []; argumentsBytes = bodyBytes = 0;
    }
    group.push(path); argumentsBytes += bytes; bodyBytes += size;
  }
  if (group.length) groups.push(group);
  return groups;
}

/** Limit whole batch lifetimes as well as child processes: do not retain all transcripts at once. */
async function mapGroups<T>(groups: string[][], work: (paths: string[]) => Promise<T[]>): Promise<T[]> {
  const results: T[][] = Array.from({ length: groups.length }, () => []);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, groups.length) }, async () => {
    while (next < groups.length) {
      const index = next++;
      results[index] = await work(groups[index]);
    }
  }));
  return results.flat();
}

/** Reject malformed stat fields rather than treating invalid metadata as a cache hit. */
function fileVersion(time: string, size: string): SessionFileVersion | undefined {
  const mtimeSeconds = Number(time), bytes = Number(size);
  if (!time || !size || !Number.isFinite(mtimeSeconds) || !Number.isSafeInteger(bytes) || bytes < 0) return undefined;
  return { mtimeMs: mtimeSeconds * 1000, size: bytes };
}

/** Batch stat startup costs; one missing file must not discard every other file in its batch. */
async function readVersions(paths: string[], execute: ExecuteRead, signal: AbortSignal): Promise<Map<string, SessionFileVersion>> {
  const versions = new Map<string, SessionFileVersion>();
  try {
    const output = await execute(["stat", "--printf", "%n\\0%Y\\0%s\\0", "--", ...paths], 5_000, 1024 * 1024);
    const fields = output.split("\0"), allowed = new Set(paths);
    if (fields.at(-1) !== "" || (fields.length - 1) % 3 !== 0) throw new Error("Invalid WSL stat framing");
    for (let i = 0; i < fields.length - 1; i += 3) {
      const path = fields[i], version = fileVersion(fields[i + 1], fields[i + 2]);
      if (!allowed.has(path) || !version) throw new Error("Invalid WSL stat record");
      versions.set(path, version);
    }
  } catch { signal.throwIfAborted(); }
  await Promise.all(paths.filter((path) => !versions.has(path)).map(async (path) => {
    try {
      const fields = (await execute(["stat", "-c", "%Y %s", path], 5_000, 1024 * 1024)).trim().split(/\s+/);
      const version = fileVersion(fields[0] ?? "", fields[1] ?? "");
      if (version) versions.set(path, version);
    } catch { signal.throwIfAborted(); }
  }));
  return versions;
}

/** Preserve readable siblings on timeout without repeating an already failed file.
 * Recovery has the scan's remaining deadline, including queue wait; parent cancellation
 * still rejects the whole scan, while a local deadline retains completed bodies. */
async function readBodies(paths: string[], execute: ExecuteRead, signal: AbortSignal, deadline?: number): Promise<Map<string, WslScanBodyRead>> {
  const bodies = new Map<string, WslScanBodyRead>(paths.map((path) => [path, { status: "failed" }]));
  if (!paths.length) return bodies;
  signal.throwIfAborted();
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  // Leave a short settlement margin for summary parsing before the existing scan watchdog.
  const expiresAt = deadline === undefined ? undefined : deadline - 100;
  const remaining = () => expiresAt === undefined ? 10_000 : Math.max(0, Math.min(10_000, expiresAt - Date.now()));
  const timer = expiresAt === undefined ? undefined : setTimeout(() => controller.abort(new Error("WSL scan body deadline reached")), Math.max(0, expiresAt - Date.now()));
  let pending = paths;
  try {
    if (remaining() === 0) return bodies;
    if (paths.length > 1) {
      try {
        const headerBytes = paths.reduce((sum, path) => sum + Buffer.byteLength(path) + 16, 0);
        const output = await execute(["sh", "-c", READ_FILES_SCRIPT, "pideck-scan-read", ...paths], remaining(), MAX_BODY_BYTES + headerBytes, controller.signal);
        const parsed = parseBodies(output, paths, false);
        if (!parsed) throw new Error("Invalid WSL body framing");
        return parsed.bodies;
      } catch (error) {
        signal.throwIfAborted();
        if (controller.signal.aborted) return bodies;
        if (error instanceof WslScanCommandError && error.timedOut) {
          const parsed = parseBodies(error.stdout, paths, true);
          if (!parsed) return bodies; // No trustworthy attempted-file boundary: do not spend another full timeout.
          for (const [path, body] of parsed.bodies) bodies.set(path, body);
          pending = parsed.pending; // Retry only files the batch never started, never its stalled current file.
        }
      }
    }
    await Promise.all(pending.map(async (path) => {
      if (controller.signal.aborted || remaining() === 0) return;
      try {
        const text = await execute(["cat", path], remaining(), MAX_BODY_BYTES, controller.signal);
        bodies.set(path, { status: "success", text });
      } catch { signal.throwIfAborted(); }
    }));
    return bodies;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** Ephemeral per-list batching: no transcript cache persists after each bounded batch is consumed. */
export async function readWslScanBatches<T>(input: {
  files: string[];
  signal: AbortSignal;
  execute: ExecuteRead;
  deadline?: number;
  needsBody: (path: string, version: SessionFileVersion) => boolean;
  consume: (path: string, read?: WslScanFileRead) => Promise<T>;
}): Promise<T[]> {
  input.signal.throwIfAborted();
  const versions = new Map<string, SessionFileVersion>();
  await mapGroups(groupPaths(input.files, METADATA_FILES), async (paths) => {
    input.signal.throwIfAborted();
    const group = await readVersions(paths, input.execute, input.signal);
    for (const [path, version] of group) versions.set(path, version);
    return [];
  });
  input.signal.throwIfAborted();
  return mapGroups(groupPaths(input.files, BODY_FILES, versions), async (paths) => {
    input.signal.throwIfAborted();
    const bodies = await readBodies(paths.filter((path) => {
      const version = versions.get(path);
      return version !== undefined && input.needsBody(path, version);
    }), input.execute, input.signal, input.deadline);
    return Promise.all(paths.map((path) => {
      const version = versions.get(path);
      return input.consume(path, version ? { version, body: bodies.get(path) ?? { status: "not-requested" } } : undefined);
    }));
  });
}
