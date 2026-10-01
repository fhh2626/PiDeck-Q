import { constants } from "node:fs";
import { copyFile, lstat, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "../utils/atomicWriteFile";

function isExistingPath(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

/** 保存损坏原件；已有历史备份不能覆盖，保存或 sync 失败必须阻止正式文件重建。 */
export async function preserveCorruptProjectCatalog(filePath: string): Promise<void> {
	let backupPath = `${filePath}.corrupt`;
	for (;;) {
		// Windows 对目录占位可能报 EPERM 而非 EEXIST；已占用的条目先换唯一名称。
		// 最终复制仍使用 EXCL，所以此预检不承担 no-clobber 的正确性保证。
		const occupied = await lstat(backupPath).catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
			throw error;
		});
		if (occupied) {
			backupPath = `${filePath}.corrupt.${randomUUID()}`;
			continue;
		}
		try {
			await copyFile(filePath, backupPath, constants.COPYFILE_EXCL);
			break;
		} catch (error) {
			if (!isExistingPath(error)) throw error;
			backupPath = `${filePath}.corrupt.${randomUUID()}`;
		}
	}
	// Windows FlushFileBuffers 需要可写句柄；只读句柄的 fsync 会报 EPERM。
	const handle = await open(backupPath, "r+");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** 在同目录独占写入并同步临时文件，再原子替换正式目录；所有失败路径都清理临时文件。 */
export async function writeProjectSnapshot(filePath: string, snapshot: string): Promise<void> {
	// 统一走 writeFileAtomic：同样是 tmp → fsync → rename，并带 Windows 杀软锁重试。
	await writeFileAtomic(filePath, snapshot);
}
