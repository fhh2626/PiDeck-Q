/**
 * 将文件/目录移入系统回收站（可恢复删除）。
 *
 * 统一入口：所有「用户主动删除」都必须走这里，禁止直接 rm/unlink 硬删
 * （历史教训：worktree 误删曾导致整目录永久丢失）。
 * 回收站不可用/被禁用时直接抛错——删除失败比永久丢失安全，
 * 调用方（IPC handler / 服务层）负责把错误呈现给用户。
 */

export type TrashContext = {
	source: string;
	/** 删除目标数（批量删除时 > 1） */
	count?: number;
};

export type TrashPath = (
	targetPath: string,
	context?: TrashContext,
) => Promise<void>;

export interface TrashLogger {
	warn(category: string, message: string, meta?: Record<string, unknown>): unknown;
	error(category: string, message: string, meta?: Record<string, unknown>): unknown;
}

export function createTrashPath(deps?: {
	trashItem?: (path: string) => Promise<void>;
	logger?: TrashLogger | null;
} | null): TrashPath {
	return async (targetPath: string, context?: TrashContext): Promise<void> => {
		try {
			if (!deps?.trashItem) {
				throw new Error("Trash service unavailable");
			}
			await deps.trashItem(targetPath);
			deps?.logger?.warn("fs:trash", "文件移入回收站", {
				path: targetPath,
				source: context?.source ?? "unknown",
				count: context?.count ?? 1,
			});
		} catch (error) {
			deps?.logger?.error("fs:trash", "回收站删除失败", {
				path: targetPath,
				source: context?.source ?? "unknown",
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	};
}
