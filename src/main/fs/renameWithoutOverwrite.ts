import { link, lstat, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** 目标已存在时抛出；IPC 层据此给出本地化提示。 */
export class RenameTargetExistsError extends Error {
	readonly code = "RENAME_TARGET_EXISTS";
	constructor(readonly targetPath: string) {
		super(`RENAME_TARGET_EXISTS: ${targetPath}`);
		this.name = "RenameTargetExistsError";
	}

	/** 按 code 判断：测试和跨模块边界时 instanceof 不可靠。 */
	static is(error: unknown): boolean {
		return typeof error === "object" && error !== null
			&& (error as { code?: unknown }).code === "RENAME_TARGET_EXISTS";
	}
}

export type RenameOperations = {
	link: typeof link;
	lstat: typeof lstat;
	rename: typeof rename;
	unlink: typeof unlink;
};

const defaultOperations: RenameOperations = { link, lstat, rename, unlink };

function hasCode(error: unknown, ...codes: string[]): boolean {
	return typeof error === "object" && error !== null && "code" in error
		&& codes.includes(String((error as { code?: unknown }).code));
}

/** 仅大小写不同（Windows/macOS 默认文件系统不区分大小写，两者是同一个条目）。 */
function isCaseOnlyChange(source: string, target: string, platform: NodeJS.Platform): boolean {
	if (platform !== "win32" && platform !== "darwin") return false;
	return source !== target && source.toLowerCase() === target.toLowerCase();
}

/**
 * 不覆盖已有目标的重命名。
 * - 普通文件：用 link(源, 目标) 独占创建目标（目标已存在时系统调用直接 EEXIST），再 unlink 源。
 *   这是 Node 中唯一由系统调用保证 no-clobber 的同卷改名方式。
 * - 目录或不支持硬链接的文件系统：退回 lstat 预检 + rename。存在极小的竞态窗口。
 * - 只改大小写：经临时名两步改名，否则预检会把“自己”误判为冲突。
 */
export async function renameWithoutOverwrite(
	source: string,
	target: string,
	operations: RenameOperations = defaultOperations,
	platform: NodeJS.Platform = process.platform,
): Promise<void> {
	if (source === target) return;
	if (isCaseOnlyChange(source, target, platform)) {
		const temp = join(dirname(source), `.${basename(source)}.${randomUUID()}.renaming`);
		await operations.rename(source, temp);
		try {
			await operations.rename(temp, target);
		} catch (error) {
			await operations.rename(temp, source).catch(() => undefined);
			throw error;
		}
		return;
	}
	const info = await operations.lstat(source);
	if (info.isFile()) {
		try {
			await operations.link(source, target);
		} catch (error) {
			if (hasCode(error, "EEXIST")) throw new RenameTargetExistsError(target);
			// FAT/exFAT、部分网络盘不支持硬链接：退回预检路径。
			if (!hasCode(error, "EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS")) throw error;
			await renameAfterExistenceCheck(source, target, operations);
			return;
		}
		await operations.unlink(source);
		return;
	}
	await renameAfterExistenceCheck(source, target, operations);
}

async function renameAfterExistenceCheck(source: string, target: string, operations: RenameOperations): Promise<void> {
	const existing = await operations.lstat(target).catch((error: unknown) => {
		if (hasCode(error, "ENOENT")) return null;
		throw error;
	});
	if (existing) throw new RenameTargetExistsError(target);
	// 预检与 rename 之间仍有极小窗口；目录无法用硬链接独占创建，这是 Node 能做到的上限。
	await operations.rename(source, target);
}
