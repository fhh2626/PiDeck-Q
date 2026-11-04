/**
 * Session 摘要缓存：内存 + 磁盘双层。
 *
 * - 命中条件：文件路径 + 版本（mtimeMs + size）
 * - 运行期内用 Map 加速周期扫描
 * - 重启后从 userData 磁盘缓存恢复，避免全量重读 JSONL
 * - 写盘采用 debounce + 原子 rename，失败静默（缓存失效只是慢，不能影响主流程）
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { renameWithRetry } from "../utils/fsRetry";

export interface SessionFileVersion {
  mtimeMs: number;
  size: number;
}

interface CacheEntry<V> {
  version: SessionFileVersion;
  value: V;
}

interface DiskCacheFile<V> {
  /** schema 版本，不兼容时整表丢弃 */
  version: number;
  entries: Record<string, CacheEntry<V>>;
}

/** Version 3 can contain wrong parents persisted by concurrent scans using shared roots.
 * These are disposable derived summaries: rebuild once, without touching session/catalog data.
 * Bump for interpretation changes as well as field changes; unchanged mtime cannot repair them. */
const DISK_SCHEMA_VERSION = 4;
const SAVE_DEBOUNCE_MS = 800;
/** 进程内 tmp 文件序号：同一进程的多个缓存实例/多次写盘不共用 tmp，避免互相截断。 */
let tmpSequence = 0;

export class SessionSummaryCache<V> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly filePath: string;
  private dirty = false;
  /** 每次标脏递增；写盘完成时序号未变才能清 dirty，写盘期间的修改留待下次写盘。 */
  private mutationSeq = 0;
  private saveTimer: NodeJS.Timeout | null = null;
  private loadPromise: Promise<void> | null = null;
  private loaded = false;
  private saving: Promise<void> | null = null;

  constructor(fileName = "session-summary-cache.json", userDataDir?: string) {
    this.filePath = join(userDataDir ?? join(homedir(), ".pi-desktop"), fileName);
  }

  /** 启动时加载磁盘缓存；可重复调用，只执行一次 */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadFromDisk()
      .catch(() => {
        // 损坏/缺失都当冷启动，不阻塞扫描
      })
      .finally(() => {
        this.loaded = true;
      });
    return this.loadPromise;
  }

  get(filePath: string, version: SessionFileVersion): V | undefined {
    const entry = this.store.get(filePath);
    if (!entry) return undefined;
    if (
      entry.version.mtimeMs !== version.mtimeMs ||
      entry.version.size !== version.size
    ) {
      this.store.delete(filePath);
      this.markDirty();
      return undefined;
    }
    return entry.value;
  }

  set(filePath: string, version: SessionFileVersion, value: V): void {
    const prev = this.store.get(filePath);
    // 内容与版本都相同则跳过，减少无意义写盘
    if (
      prev &&
      prev.version.mtimeMs === version.mtimeMs &&
      prev.version.size === version.size &&
      prev.value === value
    ) {
      return;
    }
    this.store.set(filePath, { version, value });
    this.markDirty();
  }

  /**
   * 只修剪“当前环境”下已消失的条目。
   * - local：只动 Windows 路径缓存，保留 WSL 路径
   * - wsl：只动 Linux 路径缓存，保留 Windows 路径
   * 这样切换 WSL/本地时不会互相踩盘。
   */
  prune(keepPaths: Iterable<string>, mode: "local" | "wsl" = "local"): void {
    const keep = new Set(keepPaths);
    let removed = false;
    for (const key of this.store.keys()) {
      const isWslPath = key.startsWith("/") && !/^[A-Za-z]:/.test(key);
      if (mode === "local" && isWslPath) continue;
      if (mode === "wsl" && !isWslPath) continue;
      if (!keep.has(key)) {
        this.store.delete(key);
        removed = true;
      }
    }
    if (removed) this.markDirty();
  }

  /**
   * 清空内存缓存。
   * persist=true 时同步写空盘；WSL 切换等场景应传 false，避免误删另一环境磁盘缓存。
   */
  clear(options?: { persist?: boolean }): void {
    if (this.store.size === 0) return;
    this.store.clear();
    if (options?.persist) this.markDirty();
  }

  /** 丢弃内存态并允许重新从磁盘加载（用于环境切换后恢复对应环境缓存）。 */
  async reloadFromDisk(): Promise<void> {
    this.store.clear();
    this.loaded = false;
    this.loadPromise = null;
    await this.ensureLoaded();
  }

  /** 立即刷盘（应用退出前可调用） */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.saveToDisk();
  }

  private markDirty(): void {
    this.dirty = true;
    this.mutationSeq += 1;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveToDisk();
    }, SAVE_DEBOUNCE_MS);
    // 防止 Node 因 timer 挂起进程；Electron 主进程通常不需要，但更安全
    this.saveTimer.unref?.();
  }

  private async loadFromDisk(): Promise<void> {
    const raw = await readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as DiskCacheFile<V>;
    if (!parsed || parsed.version !== DISK_SCHEMA_VERSION || !parsed.entries) {
      return;
    }
    for (const [path, entry] of Object.entries(parsed.entries)) {
      if (
        !entry ||
        typeof entry !== "object" ||
        !entry.version ||
        typeof entry.version.mtimeMs !== "number" ||
        typeof entry.version.size !== "number"
      ) {
        continue;
      }
      this.store.set(path, entry);
    }
  }

  private async saveToDisk(): Promise<void> {
    // 串行化写盘，避免并发 rename 踩踏。多个等待者在同一次写盘后会同时醒来，
    // 因此用循环重新检查：只有抢到空闲槽位的那个发起下一次写盘，其余继续等它。
    while (this.saving) {
      await this.saving;
    }
    if (!this.dirty) return;
    const saving = this.writeAtomic().finally(() => {
      if (this.saving === saving) this.saving = null;
    });
    this.saving = saving;
    await saving;
  }

  private async writeAtomic(): Promise<void> {
    const seq = this.mutationSeq;
    const tmpPath = `${this.filePath}.${process.pid}.${++tmpSequence}.tmp`;
    try {
      const entries: Record<string, CacheEntry<V>> = {};
      for (const [path, entry] of this.store) {
        entries[path] = entry;
      }
      const payload: DiskCacheFile<V> = {
        version: DISK_SCHEMA_VERSION,
        entries,
      };
      const dir = dirname(this.filePath);
      await mkdir(dir, { recursive: true });
      await writeFile(tmpPath, JSON.stringify(payload), "utf8");
      // 杀软扫描可能瞬时锁住刚写出的 tmp，rename 走退避重试；仍失败保留 dirty 下次再写
      await renameWithRetry(tmpPath, this.filePath);
      // 快照在第一个 await 前生成；写盘期间又有修改时保持 dirty（其定时器会再写一次）。
      if (this.mutationSeq === seq) this.dirty = false;
    } catch {
      // 写盘失败保留 dirty，下次 set/flush 再试；序号唯一的 tmp 不会被后续写盘覆盖，顺手清掉。
      await unlink(tmpPath).catch(() => undefined);
    }
  }
}
