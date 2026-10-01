/**
 * 项目记录。
 * 注意：新增字段必须同步到 main/projects/projectRecordValidation.ts 的 parseProjectRecord，
 * 否则该字段会在下次启动加载目录时被静默丢弃。
 */
export type Project = {
	id: string;
	name: string;
	path: string;
	lastOpenedAt: number;
	pinned?: boolean;
	sortOrder?: number;
	kind?: "chat";
	/** 是否启用 git worktree 工作区模式，开启后侧栏显示分支子项 */
	worktreeEnabled?: boolean;
	/** 如果是 worktree 子项目，指向父项目的 id */
	worktreeParentId?: string;
	/** 项目所属环境：windows 或 wsl。缺省视为 windows（兼容旧数据）。 */
	environment?: "windows" | "wsl";
};

export const SUPPORTED_EXTERNAL_EDITORS = [
	{ id: "vscode", name: "Visual Studio Code" },
	{ id: "cursor", name: "Cursor" },
	{ id: "zed", name: "Zed" },
	{ id: "sublime", name: "Sublime Text" },
	{ id: "idea", name: "IntelliJ IDEA" },
	{ id: "webstorm", name: "WebStorm" },
	{ id: "phpstorm", name: "PhpStorm" },
	{ id: "pycharm", name: "PyCharm" },
] as const;

export type ExternalEditorId = typeof SUPPORTED_EXTERNAL_EDITORS[number]["id"];

export type ExternalEditorDetectedFrom = "path" | "common-path" | "manual";

export type ExternalEditorSetting = {
	enabled: boolean;
	command: string;
	detectedFrom?: ExternalEditorDetectedFrom;
	updatedAt?: number;
};

export type ExternalEditorSettings = Record<ExternalEditorId, ExternalEditorSetting>;

export function createDefaultExternalEditorSettings(): ExternalEditorSettings {
	return Object.fromEntries(
		SUPPORTED_EXTERNAL_EDITORS.map((editor) => [
			editor.id,
			{ enabled: false, command: "" },
		]),
	) as ExternalEditorSettings;
}

export type ExternalEditor = {
	id: ExternalEditorId;
	name: string;
	command: string;
	args?: string[];
	detectedFrom: ExternalEditorDetectedFrom;
};
