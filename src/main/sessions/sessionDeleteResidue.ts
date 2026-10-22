/**
 * 删除会话时，主 JSONL 和同名子目录之外、但仍属于这次会话的残留。
 *
 * 这两类文件都不在 <stem>/ 里面，所以只删同名子目录会留下死记录：
 * - 编辑备份是 SessionFileEditor 写在会话文件旁边的
 *   `<file>.<至少13位时间戳>-<uuid>.edit-backup`。
 * - 子代理产物在会话目录共用的 subagent-artifacts/ 里，文件名以 runId 开头。
 *   runId 来自结构化工具结果；<stem>/<runId>/ 是旧记录的兼容兜底。
 *   workflow 输出目录使用已清洗的工具调用身份，async/revival 可有独立运行身份。
 *   同项目的其他会话共用这个目录，只能按可证明归属的身份收走，不能整目录删除。
 */

const EDIT_BACKUP_SUFFIX = ".edit-backup";
const EDIT_BACKUP_MIDDLE = /^\d{13,}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SHARED_SUBAGENT_ARTIFACTS_DIR = "subagent-artifacts";
/** 输出目录使用 producer 清洗后的身份，结构化目录使用原始运行身份。 */
export const NESTED_SUBAGENT_ARTIFACT_DIRS = ["outputs", "structured-output"] as const;

/** 是否是某个会话文件自己的编辑备份，而不是旁边另一个会话的备份。 */
export function isSessionEditBackupName(sessionFileName: string, candidate: string): boolean {
	const prefix = `${sessionFileName}.`;
	if (!candidate.startsWith(prefix) || !candidate.endsWith(EDIT_BACKUP_SUFFIX)) return false;
	const middle = candidate.slice(prefix.length, candidate.length - EDIT_BACKUP_SUFFIX.length);
	return EDIT_BACKUP_MIDDLE.test(middle);
}

/** 同名子目录下的 <runId>/ 才是这次子代理运行的身份；forks 之类的目录不是。 */
export function isSubagentRunDirectoryName(name: string): boolean {
	return RUN_ID.test(name);
}

/** 产物文件或目录是否属于给定的某次运行。 */
export function isArtifactOwnedByRuns(entryName: string, runIds: ReadonlySet<string>): boolean {
	for (const runId of runIds) {
		if (entryName === runId || entryName.startsWith(`${runId}_`) || entryName.startsWith(`${runId}.`)) {
			return true;
		}
	}
	return false;
}
