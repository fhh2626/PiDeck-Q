import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readlink, stat, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";

/** 特殊文件不能按普通文件复制；IPC 边界负责把内部错误码转换为本地化文案。 */
export class UnsupportedExclusiveCopyFileTypeError extends Error {
	readonly code = "FILE_COPY_UNSUPPORTED_TYPE";
	constructor() {
		super("FILE_COPY_UNSUPPORTED_TYPE");
		this.name = "UnsupportedExclusiveCopyFileTypeError";
	}
}

/** 可替换真正的独占创建原语，以确定性复现检查后的目标竞态。 */
export type ExclusiveCopyOperations = {
	copyFile: typeof copyFile;
	mkdir: typeof mkdir;
	symlink: typeof symlink;
};

/**
 * 逐项独占复制，不跟随源链接、不合并已有目录。
 * 失败保留源和已经复制的目标片段：不能递归清理目标，否则会误删竞争方创建的内容。
 * 这是移动的复制阶段，不承诺批次事务；调用方仅在整个树复制成功后删除源。
 */
export async function copyWithoutOverwrite(
	source: string,
	destination: string,
	operations: ExclusiveCopyOperations = { copyFile, mkdir, symlink },
): Promise<void> {
	const info = await lstat(source);
	if (info.isSymbolicLink()) {
		const link = await readlink(source);
		// Windows 目录 junction 可无管理员权限创建；仅查询链接类型，不复制其指向的内容。
		const targetInfo = await stat(source).catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
			throw error;
		});
		await operations.symlink(link, destination, targetInfo?.isDirectory() ? "junction" : "file");
		return;
	}
	if (info.isDirectory()) {
		// 不使用 recursive:true；现存目录也必须报 EEXIST，不能进入竞争方的目录。
		await operations.mkdir(destination);
		for (const name of await readdir(source)) {
			await copyWithoutOverwrite(join(source, name), join(destination, name), operations);
		}
		await chmod(destination, info.mode);
		await utimes(destination, info.atime, info.mtime);
		return;
	}
	if (!info.isFile()) throw new UnsupportedExclusiveCopyFileTypeError();
	// no-clobber 必须由系统调用保证，不能依赖 cp 的提前 stat 或 force:false。
	await operations.copyFile(source, destination, constants.COPYFILE_EXCL);
	await utimes(destination, info.atime, info.mtime);
}
