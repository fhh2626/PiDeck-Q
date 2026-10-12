import type { Project } from "../../shared/types";

/**
 * 把磁盘上的一条项目记录收窄为 Project；必填字段缺失或类型不对时返回 null。
 * 可选字段类型不对时丢弃该字段（兼容旧版本写入的脏值），不丢整条记录。
 *
 * 维护提示：给 Project 新增字段时必须在这里同步加一行，否则新字段会在加载时被丢掉。
 */
export function parseProjectRecord(value: unknown): Project | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || record.id.length === 0) return null;
	if (typeof record.path !== "string" || record.path.length === 0) return null;
	const project: Project = {
		id: record.id,
		path: record.path,
		// 名字缺省用路径兜底：侧栏必须有可显示标签，不能留空。
		name: typeof record.name === "string" && record.name.length > 0 ? record.name : record.path,
		lastOpenedAt: typeof record.lastOpenedAt === "number" && Number.isFinite(record.lastOpenedAt) ? record.lastOpenedAt : 0,
	};
	if (typeof record.pinned === "boolean") project.pinned = record.pinned;
	if (typeof record.sortOrder === "number" && Number.isFinite(record.sortOrder)) project.sortOrder = record.sortOrder;
	if (record.kind === "chat") project.kind = "chat";
	if (typeof record.worktreeEnabled === "boolean") project.worktreeEnabled = record.worktreeEnabled;
	if (typeof record.worktreeParentId === "string") project.worktreeParentId = record.worktreeParentId;
	if (record.environment === "windows" || record.environment === "wsl") project.environment = record.environment;
	return project;
}

/** 逐条校验；返回合法记录和被丢弃的条数，调用方据此决定是否备份原件。 */
export function parseProjectCatalog(value: unknown): { projects: Project[]; dropped: number } | null {
	if (!Array.isArray(value)) return null;
	const projects: Project[] = [];
	const seenIds = new Set<string>();
	let dropped = 0;
	for (const item of value) {
		const project = parseProjectRecord(item);
		// 重复 id 会让 get(id) 结果不确定，保留第一条。
		if (!project || seenIds.has(project.id)) {
			dropped++;
			continue;
		}
		seenIds.add(project.id);
		projects.push(project);
	}
	return { projects, dropped };
}
