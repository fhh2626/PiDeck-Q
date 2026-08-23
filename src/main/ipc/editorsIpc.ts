import { ipcChannels } from "../../shared/ipc";
import type { ExternalEditor, ExternalEditorId, ExternalEditorSetting } from "../../shared/types";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AppLogger } from "../logging/AppLogger";
import type { RpcRouter } from "../transport/RpcRouter";
import type { PlatformDialogs, PlatformShell } from "../platform/PlatformServices";
import {
	listConfiguredExternalEditors,
	mergeDetectedExternalEditors,
	detectExternalEditors,
	validateExternalEditorCommand,
	openProjectInEditor,
} from "../editors/EditorDetector";

export type EditorsIpcDeps = {
	settingsStore: SettingsStore;
	appLogger: AppLogger;
	dialogs: PlatformDialogs;
	openPath?: PlatformShell["openPath"];
};

export function registerEditorsIpc(router: RpcRouter, deps: EditorsIpcDeps): void {
	const { settingsStore, appLogger, dialogs, openPath } = deps;

	router.handle(ipcChannels.editorsList, async () => listConfiguredExternalEditors(settingsStore.get()));
	router.handle(ipcChannels.editorsChooseExecutable, async () => {
		const result = await dialogs.showOpenDialog({
			properties: ["openFile"],
			filters: process.platform === "win32"
				? [
						{ name: "Applications", extensions: ["exe", "cmd", "bat"] },
						{ name: "All Files", extensions: ["*"] },
					]
				: [{ name: "All Files", extensions: ["*"] }],
			parent: "main-window",
		});
		return result.canceled ? null : result.filePaths[0] ?? null;
	});
	router.handle(ipcChannels.editorsRedetect, async () => {
		const detected = await detectExternalEditors();
		const settings = await settingsStore.update({
			externalEditors: mergeDetectedExternalEditors(settingsStore.get().externalEditors, detected),
		});
		void appLogger.info("editor", "External editors redetected", { count: detected.length });
		return settings;
	});
	router.handle(
		ipcChannels.editorsUpdate,
		async (editorId: ExternalEditorId, patch: Partial<ExternalEditorSetting>) => {
			const current = settingsStore.get().externalEditors;
			const existing = current[editorId];
			if (!existing) throw new Error(`Unsupported editor: ${editorId}`);
			const command = typeof patch.command === "string" ? patch.command.trim() : existing.command;
			if (command) {
				const validation = await validateExternalEditorCommand(command);
				if (!validation.valid) throw new Error(`Editor path does not exist: ${command}`);
			}
			const settings = await settingsStore.update({
				externalEditors: {
					...current,
					[editorId]: {
						...existing,
						...patch,
						command,
						detectedFrom: patch.command !== undefined ? "manual" : (patch.detectedFrom ?? existing.detectedFrom),
						updatedAt: Date.now(),
					},
				},
			});
			void appLogger.info("editor", "External editor settings updated", { editorId, keys: Object.keys(patch) });
			return settings;
		},
	);
	router.handle(
		ipcChannels.editorsOpenProject,
		async (editor: ExternalEditor, projectPath: string) => {
			// 只接收已检测到的编辑器配置；打开项目不经过 shell 拼接命令,降低路径含空格时失败的概率。
			await openProjectInEditor(editor, projectPath, openPath);
			void appLogger.info("editor", "Project opened in external editor", {
				editorId: editor.id,
				editorName: editor.name,
				command: editor.command,
				args: editor.args,
				projectPath,
			});
		},
	);
}
