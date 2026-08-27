import { ipcChannels } from "../../shared/ipc";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { GitService } from "../git/GitService";
import type { WorktreeService } from "../git/WorktreeService";
import type { AgentManager } from "../pi/AgentManager";
import type { AppLogger } from "../logging/AppLogger";
import type { ProjectResourceManager } from "../projects/ProjectResourceManager";
import { registerProjectResourceIpc } from "./projectResourceIpc";
import type { RpcRouter } from "../transport/RpcRouter";
import type { PlatformDialogs } from "../platform/PlatformServices";
import {
	normalizeSelectedWslProjectPath,
	WslPathError,
	type WslEnvironment,
} from "../wsl/WslPaths";
import { resolveWslEnvironment } from "../wsl/WslEnvironment";

export type ProjectsIpcDeps = {
	projectStore: ProjectStore;
	settingsStore: SettingsStore;
	gitService: GitService;
	worktreeService: WorktreeService;
	agentManager: AgentManager;
	appLogger: AppLogger;
	projectResourceManager: ProjectResourceManager;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	dialogs: PlatformDialogs;
	sendToRenderer: (channel: string, ...args: unknown[]) => void;
};

/** PC 侧栏可见项目：始终包含 chat 项目，再按 WSL/Windows 环境过滤。 */
export function listVisibleProjects(
	projectStore: ProjectStore,
	settingsStore: SettingsStore,
) {
	const settings = settingsStore.get();
	const all = projectStore.list();
	if (settings.wslEnabled) {
		return all.filter((project) => project.kind === "chat" || project.environment === "wsl");
	}
	return all.filter((project) => (
		project.kind === "chat" || !project.environment || project.environment === "windows"
	));
}

export function registerProjectsIpc(
	router: RpcRouter,
	{
		projectStore,
		settingsStore,
		gitService,
		worktreeService,
		agentManager,
		appLogger,
		projectResourceManager,
		mainCopy,
		dialogs,
		sendToRenderer,
	}: ProjectsIpcDeps,
): void {
	const getVisibleProjects = () => listVisibleProjects(projectStore, settingsStore);

	router.handle(ipcChannels.projectsList, () => getVisibleProjects());
	router.handle(ipcChannels.projectsAdd, async () => {
		const settings = settingsStore.get();
		const env = settings.wslEnabled ? "wsl" as const : "windows" as const;
		let wslEnvironment: WslEnvironment | null = null;
		if (env === "wsl") {
			if (!settings.wslDistro) {
				throw new WslPathError("INVALID_WSL_PATH", "The active WSL environment is unavailable.");
			}
			wslEnvironment = await resolveWslEnvironment(settings.wslDistro, settings.wslUser);
			if (!wslEnvironment) {
				throw new WslPathError("INVALID_WSL_PATH", "The active WSL environment is unavailable.");
			}
		}

		const result = await dialogs.showOpenDialog({
			title: mainCopy("dialog.chooseProjectFolder"),
			...(env === "wsl" && wslEnvironment ? { defaultPath: wslEnvironment.windowsHome } : {}),
			properties: ["openDirectory"],
		});

		if (result.canceled || result.filePaths.length === 0) return null;
		let projectPath = result.filePaths[0];

		if (env === "wsl" && wslEnvironment) {
			projectPath = normalizeSelectedWslProjectPath(projectPath, wslEnvironment);
		}

		const project = await projectStore.add(projectPath, undefined, env);
		void appLogger.info("project", "Project added", { projectId: project?.id, path: project?.path, environment: env });
		return project;
	});
	router.handle(ipcChannels.projectsRemove, async (id: string) => {
		// 删除前拦截：项目仍有运行中的 Agent（pi 子进程）时禁止删除，避免进程悬挂后台继续占用资源。
		if (agentManager.hasAgentForProject(id)) {
			throw new Error("PROJECT_HAS_RUNNING_AGENT");
		}
		await projectStore.remove(id);
		void appLogger.info("project", "Project removed", { projectId: id });
		return getVisibleProjects();
	});
	router.handle(
		ipcChannels.projectsReorder,
		async (projectIds: string[]) => {
			const result = await projectStore.reorder(projectIds);
			void appLogger.info("project", "Projects reordered", { count: projectIds.length });
			return getVisibleProjects();
		},
	);

	// ── Worktree 项目管理 ──

	router.handle(ipcChannels.projectsListRoot, () => {
		return projectStore.listRoot();
	});

	router.handle(
		ipcChannels.projectsListWorktreeChildren,
		async (parentId: string) => {
			return projectStore.listWorktreeChildren(parentId);
		},
	);

	router.handle(
		ipcChannels.projectsToggleWorktreeEnabled,
		async (projectId: string) => {
			const existing = projectStore.get(projectId);
			if (!existing) throw new Error(`Project not found: ${projectId}`);
			// 即将启用时先校验是否 git 仓库；非 git 项目开启工作区模式没有意义，
			// 只会看到空列表并在创建时报错，这里提前给出明确错误让前端提示用户。
			if (!existing.worktreeEnabled) {
				const isRepo = await gitService.isGitRepo(existing.path);
				if (!isRepo) {
					throw new Error("NOT_A_GIT_REPO");
				}
			}
			const project = await projectStore.toggleWorktreeEnabled(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			// 开启 worktree 模式时，自动注册已有的 git worktree
			if (project.worktreeEnabled) {
				try {
					const entries = await worktreeService.list(project.path);
					for (const wt of entries) {
						// findByPath 返回 null 表示未注册
						if (!projectStore.findByPath(wt.path)) {
							await projectStore.add(wt.path, projectId);
						}
					}
				} catch {
					// worktree 查询失败不阻塞 toggle
				}
			}
			return project;
		},
	);

	// ── 聊天项目目录设置 ──

	router.handle(ipcChannels.projectsChooseChatPath, async () => {
		// 系统文件选择器，默认定位到当前聊天目录，便于用户就地切换。
		const result = await dialogs.showOpenDialog({
			title: mainCopy("dialog.chooseChatHistoryFolder"),
			defaultPath: projectStore.getChatProjectPath(),
			properties: ["openDirectory"],
			parent: "main-window",
		});
		if (result.canceled || result.filePaths.length === 0) return null;
		return result.filePaths[0];
	});

	router.handle(
		ipcChannels.projectsSetChatPath,
		async (path: string) => {
			if (typeof path !== "string" || path.length === 0) throw new Error("Invalid chat path");
			const project = await projectStore.setChatProjectPath(path);
			// 路径变更后广播项目列表变化，渲染端据此刷新聊天项目的会话。
			sendToRenderer(ipcChannels.projectsChanged, getVisibleProjects());
			void appLogger.info("project", "Chat project path updated", { path });
			return project;
		},
	);

	registerProjectResourceIpc(router, {
		appLogger,
		projectResourceManager,
	});
}
