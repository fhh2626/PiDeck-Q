import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import * as hostPath from "node:path";
import * as posixPath from "node:path/posix";
import { collectDirectoryRunIdentities, collectSessionRunIdentities } from "./sessionDeleteOwnership";
import { isArtifactOwnedByRuns, isSessionEditBackupName, SHARED_SUBAGENT_ARTIFACTS_DIR, NESTED_SUBAGENT_ARTIFACT_DIRS } from "./sessionDeleteResidue";

export const DELETE_SESSION_READ_LIMIT = 64 * 1024 * 1024;
const TOTAL_SESSION_READ_LIMIT = 256 * 1024 * 1024;
const DIRECTORY_ENTRY_LIMIT = 10000;

export interface SessionDeleteFiles {
  listNames(directory: string): Promise<string[]>;
  isDirectory(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  readSession(path: string): Promise<string | undefined>;
}
export interface SessionDeleteResidue {
  backups: string[];
  artifacts: string[];
}

/** Only confirmed absence is benign; permissions and IO failures must preserve retryable ownership. */
export function isMissingDeletePath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Bounded, UTF-8-safe read even if an external process grows a session during deletion. */
async function readLocalDeleteSession(path: string): Promise<string | undefined> {
  let file: FileHandle;
  try { file = await open(path, "r"); } catch (error) {
    if (isMissingDeletePath(error)) return undefined;
    throw error;
  }
  try {
    if ((await file.stat()).size > DELETE_SESSION_READ_LIMIT) throw new Error("Session exceeds deletion ownership read limit");
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder("utf8");
    const chunks: string[] = [];
    let total = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > DELETE_SESSION_READ_LIMIT) throw new Error("Session exceeds deletion ownership read limit");
      chunks.push(decoder.write(buffer.subarray(0, bytesRead)));
    }
    chunks.push(decoder.end());
    return chunks.join("");
  } finally { await file.close(); }
}

/** Local adapter does not follow links into external directories when collecting shared artifacts. */
export const localSessionDeleteFiles: SessionDeleteFiles = {
  async listNames(directory) {
    try { return (await readdir(directory, { withFileTypes: true })).map((entry) => entry.name); }
    catch (error) { if (isMissingDeletePath(error)) return []; throw error; }
  },
  async isDirectory(path) {
    try { return (await lstat(path)).isDirectory(); }
    catch (error) { if (isMissingDeletePath(error)) return false; throw error; }
  },
  async isFile(path) {
    try { return (await lstat(path)).isFile(); }
    catch (error) { if (isMissingDeletePath(error)) return false; throw error; }
  },
  readSession: readLocalDeleteSession,
};

/**
 * Collect before mutating any paths, preserving ownership on enumeration failure.
 * Existing result metadata supplies workflow/async/revival IDs; legacy UUID directories are a fallback.
 * A copied/forked session can retain the same results, so live peer references must be retained.
 * No path from a tool result is ever used as a deletion target.
 */
export async function collectSessionDeleteResidue(
  filePath: string,
  siblingDir: string | undefined,
  files: SessionDeleteFiles,
  wsl = false,
): Promise<SessionDeleteResidue> {
  const paths = wsl ? posixPath : hostPath;
  const directory = paths.dirname(filePath);
  const name = paths.basename(filePath);
  async function names(dir: string): Promise<string[]> {
    const entries = await files.listNames(dir);
    if (entries.length > DIRECTORY_ENTRY_LIMIT) throw new Error("Session deletion directory entry limit exceeded");
    if (entries.some((entry) => !entry || entry === "." || entry === ".." || /[\/\\\r\n\0]/.test(entry))) {
      throw new Error("Invalid session deletion directory entry");
    }
    return entries;
  }
  const entries = await names(directory);
  const backups: string[] = [];
  for (const entry of entries) {
    if (isSessionEditBackupName(name, entry) && await files.isFile(paths.join(directory, entry))) backups.push(paths.join(directory, entry));
  }
  const artifactsDir = paths.join(directory, SHARED_SUBAGENT_ARTIFACTS_DIR);
  if (!(await files.isDirectory(artifactsDir))) return { backups, artifacts: [] };
  let bytesRead = 0;
  async function identities(path: string): Promise<Set<string>> {
    const raw = await files.readSession(path);
    if (raw === undefined) return new Set();
    const bytes = Buffer.byteLength(raw, "utf8");
    bytesRead += bytes;
    if (bytes > DELETE_SESSION_READ_LIMIT || bytesRead > TOTAL_SESSION_READ_LIMIT) throw new Error("Session deletion ownership read limit exceeded");
    return collectSessionRunIdentities(raw);
  }
  const runIds = await identities(filePath);
  if (siblingDir && await files.isDirectory(siblingDir)) {
    const candidates = collectDirectoryRunIdentities(await names(siblingDir));
    for (const candidate of candidates) {
      if (await files.isDirectory(paths.join(siblingDir, candidate))) runIds.add(candidate);
    }
  }
  if (runIds.size === 0) return { backups, artifacts: [] };
  // Read peers before collecting/removing artifacts; a failed read cannot authorize removing shared data.
  for (const peer of entries) {
    if (peer === name || !peer.endsWith(".jsonl")) continue;
    const peerPath = paths.join(directory, peer);
    if (!(await files.isFile(peerPath))) continue;
    for (const id of await identities(peerPath)) runIds.delete(id);
  }
  const artifacts: string[] = [];
  async function collect(dir: string): Promise<void> {
    for (const entry of await names(dir)) {
      if (isArtifactOwnedByRuns(entry, runIds)) artifacts.push(paths.join(dir, entry));
    }
  }
  await collect(artifactsDir);
  for (const nested of NESTED_SUBAGENT_ARTIFACT_DIRS) {
    const nestedDir = paths.join(artifactsDir, nested);
    if (await files.isDirectory(nestedDir)) await collect(nestedDir);
  }
  return { backups, artifacts };
}
