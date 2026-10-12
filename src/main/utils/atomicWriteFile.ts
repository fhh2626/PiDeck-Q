import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { renameWithRetry } from "./fsRetry";

/**
 * 原子写文本文件：写同目录 tmp → fsync → rename 覆盖目标。
 * 中途崩溃/断电时目标文件要么是旧内容、要么是新内容，不会留下截断 JSON。
 * - 目标是软链时写到真实文件，避免把用户 dotfiles 软链替换成普通文件；
 * - 保留已有文件权限（auth.json 可能是 0600，不能因替换变成全局可读）；
 * - rename 走 renameWithRetry，吸收 Windows 杀软/索引的瞬时锁。
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
	const targetPath = await realpath(filePath).catch(() => filePath);
	await mkdir(dirname(targetPath), { recursive: true });
	const existingMode = await stat(targetPath)
		.then((info) => info.mode & 0o777)
		.catch(() => undefined);
	const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const handle = await open(tempPath, "w", existingMode ?? 0o666);
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		// open 的 mode 受 umask 影响，显式 chmod 才能精确保留原权限
		if (existingMode !== undefined && process.platform !== "win32") {
			await chmod(tempPath, existingMode);
		}
		await renameWithRetry(tempPath, targetPath);
	} finally {
		// 成功时 tmp 已被 rename 掉，这里的 ENOENT 忽略；失败时清理残留
		await unlink(tempPath).catch(() => undefined);
	}
}
