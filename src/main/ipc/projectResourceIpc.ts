import { ipcChannels } from "../../shared/ipc";
import type { CreateProjectSkillInput } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { ProjectResourceManager } from "../projects/ProjectResourceManager";
import type { RpcRouter } from "../transport/RpcRouter";

export type ProjectResourceIpcDeps = {
	appLogger: Pick<AppLogger, "info">;
	projectResourceManager: ProjectResourceManager;
};

export function registerProjectResourceIpc(
	router: RpcRouter,
	{
		appLogger,
		projectResourceManager,
	}: ProjectResourceIpcDeps,
): void {
	router.handle(ipcChannels.projectResourcesList, async (projectId: string) => {
		return projectResourceManager.list(projectId);
	});
	router.handle(ipcChannels.projectResourcesCreateSkill, async (input: CreateProjectSkillInput) => {
		const result = await projectResourceManager.createSkill(input);
		void appLogger.info("project-resource", "Project skill created", { projectId: input.projectId, name: result.name });
		return result;
	});
	router.handle(ipcChannels.projectResourcesDeleteSkill, async (projectId: string, skillPath: string) => {
		// The manager resolves and rechecks project ownership before deleting renderer-supplied paths.
		await projectResourceManager.deleteSkill(projectId, skillPath);
		void appLogger.info("project-resource", "Project skill deleted", { projectId, skillPath });
	});
	router.handle(ipcChannels.projectResourcesDeleteExtension, async (projectId: string, extensionPath: string) => {
		// Extensions are discovered locally; deletion remains constrained to the project's extension directory.
		await projectResourceManager.deleteExtension(projectId, extensionPath);
		void appLogger.info("project-resource", "Project extension deleted", { projectId, extensionPath });
	});
	router.handle(ipcChannels.projectResourcesToggleSkill, async (projectId: string, skillPath: string, enabled: boolean) => {
		const result = await projectResourceManager.toggleSkill(projectId, skillPath, enabled);
		void appLogger.info("project-resource", "Project skill toggled", { projectId, skillPath, enabled });
		return result;
	});
	router.handle(ipcChannels.projectResourcesToggleExtension, async (projectId: string, extensionPath: string, enabled: boolean) => {
		await projectResourceManager.toggleExtension(projectId, extensionPath, enabled);
		void appLogger.info("project-resource", "Project extension toggled", { projectId, extensionPath, enabled });
	});
	router.handle(ipcChannels.projectResourcesRenameSkill, async (projectId: string, skillPath: string, newName: string) => {
		const result = await projectResourceManager.renameSkill(projectId, skillPath, newName);
		void appLogger.info("project-resource", "Project skill renamed", { projectId, skillPath, newName });
		return result;
	});
}
