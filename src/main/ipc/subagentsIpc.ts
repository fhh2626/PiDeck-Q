/**
 * 子代理偏好 IPC handler（薄层：只做入参校验与适配，读写逻辑在 SubagentSettingsStore）。
 */

import { ipcChannels } from "../../shared/ipc";
import type { SubagentSettingsScope } from "../../shared/types";
import type { RpcRouter } from "../transport/RpcRouter";
import {
	SubagentSettingsStore,
	validateSubagentSettings,
} from "../subagents/SubagentSettingsStore";

/** 作用域白名单：渲染层数据一律不可信，非法值直接拒绝。 */
function parseScope(value: unknown): SubagentSettingsScope {
	if (value === "global" || value === "project") return value;
	throw new Error("scope must be \"global\" or \"project\"");
}

/** 项目 id 只在 project 作用域需要；空串按缺省处理。 */
function parseProjectId(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw new Error("projectId must be a string");
	return value;
}

export function registerSubagentsIpc(
	router: RpcRouter,
	store: SubagentSettingsStore,
): void {
	router.handle(ipcChannels.subagentsGetSettings, async (projectId?: unknown) =>
		store.read(parseProjectId(projectId)),
	);

	router.handle(
		ipcChannels.subagentsSaveSettings,
		async (scope: unknown, projectId: unknown, settings: unknown) => {
			const parsedScope = parseScope(scope);
			const parsedProjectId = parseProjectId(projectId);
			// project 作用域必须有项目：避免把项目配置误写进全局文件。
			if (parsedScope === "project" && !parsedProjectId) {
				throw new Error("projectId is required for project scope");
			}
			await store.save(parsedScope, parsedProjectId, validateSubagentSettings(settings));
			return { ok: true };
		},
	);
}
