import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Project } from "../../shared/types";
import {
  normalizeSelectedWslProjectPath,
  parseWslUncPath,
  type WslEnvironment,
} from "../wsl/WslPaths";

const CHAT_PROJECT_ID = "builtin-chat";
const CHAT_PROJECT_NAME = "Chat";

export interface ProjectStoreDeps {
  projectsFile?: string;
  chatPathFile?: string;
  defaultChatProjectPath?: string;
  userDataDir?: string;
}

export class ProjectStore {
  private readonly filePath: string;
  private readonly chatPathFile: string;
  // 聊天工作区目录：默认在 userData 下，用户可在侧栏聊天项目设置中改为任意目录并持久化。
  private chatProjectPath: string;
  private projects: Project[] = [];

  constructor(
    deps?: ProjectStoreDeps | string,
  ) {
    const home = homedir();
    let defaultBase = join(home, ".pi-desktop");
    if (typeof deps === "string") {
      defaultBase = deps;
    }
    const options = typeof deps === "object" && deps !== null ? deps : undefined;
    if (options?.userDataDir) {
      defaultBase = options.userDataDir;
    }
    this.filePath = options?.projectsFile ?? join(defaultBase, "projects.json");
    this.chatPathFile = options?.chatPathFile ?? join(defaultBase, "chat-path.json");
    this.chatProjectPath = options?.defaultChatProjectPath ?? join(defaultBase, "chat-workspace");
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.projects = JSON.parse(raw) as Project[];
    } catch {
      this.projects = [];
    }
    // 先读取用户自定义的聊天目录（若存在），再据此修正内置聊天项目路径。
    await this.loadChatProjectPath();
    const chatChanged = this.ensureChatProject();
    const orderChanged = this.ensureSortOrder();
    const changed = chatChanged || orderChanged;
    await mkdir(this.chatProjectPath, { recursive: true });
    if (changed) await this.save();
    return this.list();
  }

  list() {
    return [...this.projects].sort((a, b) =>
      Number(this.isChatProject(b)) - Number(this.isChatProject(a))
      || Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
      || this.projectSortOrder(a) - this.projectSortOrder(b)
      || b.lastOpenedAt - a.lastOpenedAt
    );
  }

  get(id: string) {
    return this.projects.find(project => project.id === id);
  }

  getChatProjectPath() {
    return this.chatProjectPath;
  }

  /**
   * 设置内置聊天项目的会话目录并持久化。
   * 更新内存中的聊天项目路径、写入 chat-path.json，并确保目标目录存在。
   * 返回更新后的聊天项目（便于主进程向渲染端广播 projects:changed）。
   */
  async setChatProjectPath(path: string) {
    const normalized = this.normalizeProjectPath(path);
    // 边界保护：聊天目录不允许指向已注册的普通项目目录（issue #149）。否则聊天项目与
    // 该项目同路径并存，重启后 ensureChatProject 曾把该项目整条吸收，且「添加项目」选
    // 同一目录只会返回 builtin-chat，项目区永远不再出现新项目。
    const occupied = this.projects.find(
      (project) => !this.isChatProject(project) && this.sameProjectPath(project.path, normalized),
    );
    if (occupied) {
      throw new Error("CHAT_PATH_OVERLAPS_PROJECT");
    }
    this.chatProjectPath = normalized;
    const chat = this.projects.find(project => this.isChatProject(project));
    if (chat) {
      chat.path = normalized;
    }
    await mkdir(this.chatProjectPath, { recursive: true });
    await this.saveChatProjectPath(normalized);
    await this.save();
    return chat ?? null;
  }

  private async saveChatProjectPath(path: string) {
    await mkdir(dirname(this.chatPathFile), { recursive: true });
    await writeFile(this.chatPathFile, JSON.stringify({ path }, null, 2), "utf8");
  }

  private async loadChatProjectPath() {
    try {
      const raw = await readFile(this.chatPathFile, "utf8");
      const parsed = JSON.parse(raw) as { path?: string };
      if (parsed.path) this.chatProjectPath = this.normalizeProjectPath(parsed.path);
    } catch {
      // 无自定义路径时保持默认 userData/chat-workspace
    }
  }

  /** 添加项目，可指定所属环境（缺省 windows） */
  async add(path: string, worktreeParentId?: string, environment?: "windows" | "wsl") {
    const normalizedPath = this.normalizeProjectPath(path);
    // 内置聊天项目不参与「同路径即已有项目」匹配（issue #149）：用户挑选的目录即使与
    // 聊天目录相同，也必须创建真正的项目记录——否则 add() 永远返回 builtin-chat，
    // 项目区不再出现新项目，侧栏只剩聊天区。
    const existing = this.projects.find(
      (project) => !this.isChatProject(project) && this.sameProjectPath(project.path, normalizedPath),
    );
    if (existing) {
      existing.path = normalizedPath;
      existing.lastOpenedAt = Date.now();
      // 外部已有 worktree 可能曾经作为顶级项目加入；开启工作区后需要补上父子关系。
      if (worktreeParentId && existing.id !== worktreeParentId) {
        existing.worktreeParentId = worktreeParentId;
        existing.pinned = false;
      }
      await this.save();
      return existing;
    }

    const project: Project = {
      id: randomUUID(),
      name: basename(normalizedPath) || normalizedPath,
      path: normalizedPath,
      lastOpenedAt: Date.now(),
      sortOrder: this.nextSortOrder(),
      // 兼容旧数据：environment 缺省视为 windows
      environment: environment || "windows",
      ...(worktreeParentId ? { worktreeParentId } : {}),
    };

    this.projects.push(project);
    await this.save();
    return project;
  }

  async remove(id: string) {
    // 删除父项目时同步移除子项目记录，避免留下不可见的孤儿 worktree 项目。
    this.projects = this.projects.filter(project =>
      project.id !== id && project.worktreeParentId !== id
    );
    this.ensureChatProject();
    this.ensureSortOrder();
    await this.save();
    return this.list();
  }

  async reorder(projectIds: string[]) {
    // 置顶项优先保留在顶部，其余按传入的拖拽顺序赋予递增 sortOrder
    const chatProject = this.projects.find((project) => this.isChatProject(project));
    if (chatProject) chatProject.sortOrder = -1;

    let order = 0;
    for (const id of projectIds) {
      const project = this.projects.find((item) => item.id === id && !this.isChatProject(item));
      if (project) {
        project.sortOrder = order++;
      }
    }
    // 未在传入列表中的项目（如新发现的 worktree）排在末尾
    for (const project of this.projects) {
      if (!this.isChatProject(project) && !projectIds.includes(project.id)) {
        project.sortOrder = order++;
      }
    }

    await this.save();
    return this.list();
  }

  private ensureChatProject() {
    const existing = this.projects.find((project) => this.isChatProject(project));
    const nextChatProject: Project = {
      id: CHAT_PROJECT_ID,
      name: CHAT_PROJECT_NAME,
      path: this.chatProjectPath,
      lastOpenedAt: existing?.lastOpenedAt ?? Date.now(),
      pinned: true,
      sortOrder: -1,
      kind: "chat",
    };

    if (!existing) {
      this.projects.unshift(nextChatProject);
      return true;
    }

    const previousLength = this.projects.length;
    const changed =
      existing.id !== nextChatProject.id ||
      existing.name !== nextChatProject.name ||
      existing.path !== nextChatProject.path ||
      existing.kind !== nextChatProject.kind ||
      existing.pinned !== nextChatProject.pinned ||
      existing.sortOrder !== nextChatProject.sortOrder;
    Object.assign(existing, nextChatProject);
    // 仅去重多余的聊天项目记录（kind/id 命中），普通项目即使路径与聊天目录相同也保留。
    this.projects = this.projects.filter(
      (project, index) =>
        index === this.projects.indexOf(existing) ||
        (!this.isChatProject(project) && project.id !== CHAT_PROJECT_ID),
    );
    return changed || this.projects.length !== previousLength;
  }

  private ensureSortOrder() {
    const needsOrder = this.projects.some(
      (project) => typeof project.sortOrder !== "number" || Number.isNaN(project.sortOrder),
    );
    if (!needsOrder) return false;

    // 首次升级旧数据时保留原来的“置顶优先 + 最近打开”顺序，之后由用户拖拽顺序接管。
    [...this.projects]
      .filter((project) => !this.isChatProject(project))
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.lastOpenedAt - a.lastOpenedAt)
      .forEach((project, index) => {
        project.sortOrder = index;
      });
    const chatProject = this.projects.find((project) => this.isChatProject(project));
    if (chatProject) chatProject.sortOrder = -1;
    return true;
  }

  private nextSortOrder() {
    if (this.projects.length === 0) return 0;
    return Math.max(...this.projects.map((project) => this.projectSortOrder(project))) + 1;
  }

  private projectSortOrder(project: Project) {
    return typeof project.sortOrder === "number" && !Number.isNaN(project.sortOrder)
      ? project.sortOrder
      : Number.MAX_SAFE_INTEGER;
  }

  /** 仅返回顶级项目（非 worktree 子项目），用于侧栏主列表 */
  listRoot() {
    return this.list().filter(p => !p.worktreeParentId);
  }

  /** 获取指定父项目的所有 worktree 子项目 */
  listWorktreeChildren(parentId: string) {
    return this.list().filter(p => p.worktreeParentId === parentId);
  }

  /** 按路径查找项目；Windows 上忽略大小写和分隔符差异。 */
  findByPath(path: string) {
    const normalizedPath = this.normalizeProjectPath(path);
    return this.projects.find(project => this.sameProjectPath(project.path, normalizedPath)) ?? null;
  }

  async toggleWorktreeEnabled(id: string) {
    const project = this.get(id);
    if (!project) return null;
    project.worktreeEnabled = !project.worktreeEnabled;
    // 关闭工作区模式时，清除已注册的 worktree 子项目记录，避免侧栏不再展示它们后
    // 仍残留在 projects.json 中成为孤儿数据。仅移除项目记录，不删除物理 worktree 目录。
    if (!project.worktreeEnabled) {
      this.clearWorktreeChildren(id);
    }
    await this.save();
    return project;
  }

  /** 移除指定父项目下的所有 worktree 子项目记录（不删除物理目录） */
  clearWorktreeChildren(parentId: string) {
    this.projects = this.projects.filter(
      (project) => project.worktreeParentId !== parentId || this.isChatProject(project),
    );
  }

  private isChatProject(project: Project) {
    return project.kind === "chat" || project.id === CHAT_PROJECT_ID;
  }

  private normalizeProjectPath(path: string) {
    // WSL Linux 路径（/mnt/d/xxx、/home/user/...）不能走 Windows path.resolve/normalize，
    // 否则 /mnt/d/xxx 会被解析为 D:\mnt\d\xxx。仅去除尾部斜杠。
    if (process.platform === "win32" && path.startsWith("/")) {
      return path.replace(/\/+$/, "");
    }
    return normalize(resolve(path));
  }

  private sameProjectPath(a: string, b: string) {
    const leftWsl = parseWslUncPath(a);
    const rightWsl = parseWslUncPath(b);
    if (leftWsl && rightWsl) {
      return leftWsl.distro.toLowerCase() === rightWsl.distro.toLowerCase()
        && leftWsl.linuxPath === rightWsl.linuxPath;
    }
    const left = this.normalizeProjectPath(a);
    const right = this.normalizeProjectPath(b);
    // WSL 路径保留原始大小写（Linux 文件系统区分大小写）
    if (process.platform === "win32" && a.startsWith("/") && b.startsWith("/")) {
      return left === right;
    }
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  private async save() {
    // 项目列表是桌面端自己的轻量状态，不写入 pi session，避免影响 pi 原生会话格式。
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.projects, null, 2), "utf8");
  }
}
