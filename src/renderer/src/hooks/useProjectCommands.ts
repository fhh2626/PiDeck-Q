import type { GitBranchInfo, Project } from "../../../shared/types";
import { desktopApi as api } from "../desktopApi";
import { t } from "../i18n";
import { isChatProject } from "../rendererUtils";
import { invalidateProjectInventoryRequests } from "../utils/projectInventoryRequests";

type ProjectCommandsInput = {
	projects: Project[];
	activeProjectId: string | undefined;
	gitInfo: GitBranchInfo;
	setProjects: (projects: Project[]) => void;
	upsertProject: (project: Project) => void;
	setActiveProjectId: (projectId: string) => void;
	setGitInfo: (info: GitBranchInfo) => void;
	setProjectBranch: (projectId: string, branch: string | null) => void;
	refreshProjects: () => Promise<void>;
	refreshProjectSessions: (projectId: string, silent?: boolean) => Promise<unknown>;
	onProjectRemoved: (projectId: string, projects: Project[]) => void;
	showToast: (message: string, duration?: number) => void;
	overlays: {
		showConfirm: (config: {
			title: string;
			message: string;
			onConfirm: () => void;
			confirmLabel?: string;
		}) => void;
		clearConfirm: () => void;
	};
};

/** Owns project-list mutations and active-project branch commands. */
export function useProjectCommands(input: ProjectCommandsInput) {
	async function reorderProjects(sourceProjectId: string, targetProjectId: string): Promise<void> {
		if (sourceProjectId === targetProjectId) return;
		const sourceProject = input.projects.find((project) => project.id === sourceProjectId);
		const targetProject = input.projects.find((project) => project.id === targetProjectId);
		if (isChatProject(sourceProject) || isChatProject(targetProject)) return;
		const sourceIndex = input.projects.findIndex((project) => project.id === sourceProjectId);
		const targetIndex = input.projects.findIndex((project) => project.id === targetProjectId);
		if (sourceIndex === -1 || targetIndex === -1) return;

		const previousProjects = input.projects;
		const nextProjects = [...input.projects];
		const [movedProject] = nextProjects.splice(sourceIndex, 1);
		const targetIndexAfterRemoval = nextProjects.findIndex((project) => project.id === targetProjectId);
		const insertIndex = sourceIndex < targetIndex ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval;
		nextProjects.splice(insertIndex, 0, movedProject);
		invalidateProjectInventoryRequests();
		input.setProjects(nextProjects);
		try {
			const reordered = await api.projects.reorder(nextProjects.map((project) => project.id));
			invalidateProjectInventoryRequests();
			input.setProjects(reordered);
		} catch (error) {
			input.setProjects(previousProjects);
			input.showToast(t("app.projectSortFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
		}
	}

	async function addProject(): Promise<void> {
		try {
			const project = await api.projects.add();
			// 用户取消目录选择器是正常流程，不需要错误提示。
			if (!project) return;
			await input.refreshProjects();
			input.setActiveProjectId(project.id);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			input.showToast(t("app.projectAddFailed", { error: message }), 5000);
		}
	}

	async function removeSidebarProject(project: Project): Promise<void> {
		try {
			const next = await api.projects.remove(project.id);
			invalidateProjectInventoryRequests();
			input.setProjects(next);
			input.onProjectRemoved(project.id, next);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("PROJECT_HAS_RUNNING_AGENT")) {
				input.overlays.showConfirm({
					title: t("app.projectRemoveBlockedTitle"),
					message: t("app.projectRemoveBlockedByAgent"),
					confirmLabel: t("app.projectRemoveBlockedAck"),
					onConfirm: input.overlays.clearConfirm,
				});
				return;
			}
			input.showToast(message, 5000);
		}
	}

	async function changeChatPath(project: Project): Promise<void> {
		try {
			const picked = await api.projects.chooseChatPath();
			if (!picked || picked === project.path) return;
			const updatedProject = await api.projects.setChatPath(picked);
			// IPC 已返回持久化后的权威项目对象，先更新本地 inventory，
			// 不等待 projects:changed 事件，避免旧 list() snapshot 抢先回写。
			invalidateProjectInventoryRequests();
			if (updatedProject) input.upsertProject(updatedProject);
			await input.refreshProjectSessions(project.id);
			input.showToast(t("app.chatProjectPathUpdated"), 1800);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			input.showToast(message.includes("CHAT_PATH_OVERLAPS_PROJECT") ? t("app.chatPathOverlapsProject") : message, 5000);
		}
	}

	async function switchBranch(branch: string): Promise<void> {
		const projectId = input.activeProjectId;
		if (!projectId || !branch || branch === input.gitInfo.current) return;
		try {
			const next = await api.git.checkout(projectId, branch);
			input.setGitInfo(next);
			input.setProjectBranch(projectId, next.current);
		} catch (error) {
			input.showToast(t("app.branchSwitchFailed", { error: error instanceof Error ? error.message : String(error) }));
			const refreshed = await api.git.branches(projectId).catch(() => ({ current: null, branches: [] }));
			input.setGitInfo(refreshed);
			input.setProjectBranch(projectId, refreshed.current);
		}
	}

	async function createBranch(branchName: string): Promise<void> {
		const projectId = input.activeProjectId;
		if (!projectId || !branchName.trim()) return;
		try {
			const next = await api.git.createBranch(projectId, branchName);
			input.setGitInfo(next);
			input.setProjectBranch(projectId, next.current);
			input.showToast(t("app.branchCreated", { branch: branchName }), 2500);
		} catch (error) {
			input.showToast(t("app.branchCreateFailed", { error: error instanceof Error ? error.message : String(error) }));
		}
	}

	return { reorderProjects, addProject, removeSidebarProject, changeChatPath, switchBranch, createBranch };
}
