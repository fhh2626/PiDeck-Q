import { readdir, rename as fsRename, mkdir, writeFile, stat } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import type { TrashPath } from "./trash";
import type { FileTreeNode } from "../../shared/types";

const ignoredNames = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".venv", "__pycache__"]);

// 文件侧边栏需要能展示常见前端/桌面项目的深层源码目录；保留上限是为了避免误打开超大仓库时递归读取拖慢 UI。
const DEFAULT_FILE_TREE_MAX_DEPTH = 12;

export class FileSystemService {
  constructor(private readonly trashPath?: TrashPath) {}
  async listTree(root: string, maxDepth = DEFAULT_FILE_TREE_MAX_DEPTH): Promise<FileTreeNode[]> {
    return this.readDirectory(root, root, 0, maxDepth);
  }

  private async readDirectory(root: string, current: string, depth: number, maxDepth: number): Promise<FileTreeNode[]> {
    const entries = await readdir(current, { withFileTypes: true });
    // 并行 stat：为排序（名称/更新时间/创建时间/大小）附加元数据。
    // 目录 stat.size 无意义，恒置 0；目录仍保留时间戳用于“按更新时间/创建时间”排序。
    const stats = await Promise.all(
      entries.map(async (entry) => {
        try {
          return await stat(join(current, entry.name));
        } catch {
          // 竞态删除/无权限：回退空 stat，节点仍以名称排序兜底
          return null;
        }
      }),
    );
    const nodes: FileTreeNode[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (ignoredNames.has(entry.name)) continue;

      const absolutePath = join(current, entry.name);
      const relativePath = relative(root, absolutePath).replace(/\\/g, "/");
      const meta = stats[i];
      const sharedMeta = meta
        ? { mtimeMs: meta.mtimeMs, ctimeMs: meta.ctimeMs, size: meta.isDirectory() ? 0 : meta.size }
        : undefined;

      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: absolutePath,
          relativePath,
          type: "directory",
          ...sharedMeta,
          // 深度达到上限时停止继续递归；上限由默认常量控制，兼顾深层目录展示和大仓库性能。
          children: depth < maxDepth ? await this.readDirectory(root, absolutePath, depth + 1, maxDepth) : [],
        });
      } else if (entry.isFile()) {
        nodes.push({
          name: entry.name,
          path: absolutePath,
          relativePath,
          type: "file",
          ...sharedMeta,
        });
      }
    }

    // 默认按名称（目录优先）排序；维度切换排序由渲染层 fileTreeSort 承担
    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  /** 删除文件或空目录；非空目录需要递归删除 */
  async delete(targetPath: string, _recursive = false): Promise<void> {
    if (!this.trashPath) {
      throw new Error("Trash service unavailable");
    }
    await this.trashPath(targetPath, { source: "files:delete" });
  }

  /** 重命名文件或目录 */
  async rename(targetPath: string, newName: string): Promise<string> {
    const parent = dirname(targetPath);
    const newPath = join(parent, newName);
    await fsRename(targetPath, newPath);
    return newPath;
  }

	/** 创建文件或目录，返回完整路径 */
	async create(parentDir: string, name: string, type: "file" | "directory"): Promise<string> {
		const fullPath = join(parentDir, name);
		// P0 security: prevent path traversal via ../ in name
		if (name.includes("..") || !fullPath.startsWith(parentDir)) {
			throw new Error(`Invalid path: "${name}" escapes parent directory`);
		}
		if (type === "directory") {
			await mkdir(fullPath, { recursive: true });
		} else {
			await writeFile(fullPath, "", "utf8");
		}
		return fullPath;
	}
}
