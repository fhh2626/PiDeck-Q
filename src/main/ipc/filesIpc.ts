import { cp, readFile, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import type { FileSystemService } from "../fs/FileSystemService";
import {
	assertAuthorizedFilePath,
	type AuthorizedPathMode,
} from "../fs/authorizedPaths";
import type { ExternalFileCapabilityStore } from "../fs/ExternalFileCapabilityStore";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AppLogger } from "../logging/AppLogger";
import type { RpcRouter } from "../transport/RpcRouter";
import type { PlatformDialogs, PlatformShell } from "../platform/PlatformServices";

function hasNodeErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function assertString(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} must be a non-empty string.`);
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
		throw new TypeError(`${field} must be a non-empty string array.`);
	}
}

const MAX_EXTERNAL_FILE_READ_BYTES = 10 * 1024 * 1024;

function assertExternalReadLimit(maxBytes: unknown): asserts maxBytes is number {
	if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0 || maxBytes > MAX_EXTERNAL_FILE_READ_BYTES) {
		throw new TypeError(`External clipboard reads require maxBytes between 1 and ${MAX_EXTERNAL_FILE_READ_BYTES}.`);
	}
}

export type FilesIpcFileOperations = {
	rename: typeof fsRename;
	copy: typeof cp;
	remove: typeof rm;
};

export type FilesIpcDeps = {
	fileSystemService: FileSystemService;
	projectStore: ProjectStore;
	settingsStore: SettingsStore;
	appLogger: Pick<AppLogger, "info" | "error">;
	dialogs: PlatformDialogs;
	platformShell: Pick<PlatformShell, "openPath" | "showItemInFolder">;
	getAuthorizedRoots: () => string[];
	/** Capabilities issued by the trusted native clipboard/drop boundary. */
	externalFileCapabilities?: Pick<ExternalFileCapabilityStore, "consumeCopy" | "consumeRead">;
	/** Optional seam for deterministic cross-device move tests. */
	fileOperations?: Partial<FilesIpcFileOperations>;
};

export function registerFilesIpc(
	router: RpcRouter,
	{
		fileSystemService,
		projectStore,
		settingsStore,
		appLogger,
		dialogs,
		platformShell,
		getAuthorizedRoots,
		externalFileCapabilities,
		fileOperations,
	}: FilesIpcDeps,
): void {
	const fsOperations: FilesIpcFileOperations = {
		rename: fileOperations?.rename ?? fsRename,
		copy: fileOperations?.copy ?? cp,
		remove: fileOperations?.remove ?? rm,
	};
	// 将 WSL Linux 路径转为 Windows 可访问的路径（/mnt/c → C:\，/home/... → \\wsl$\<distro>\...）
	const toWindowsPath = (linuxPath: string): string => {
		if (!linuxPath || /^[A-Za-z]:/.test(linuxPath)) return linuxPath; // 已是 Windows 路径
		if (/^[\\/]{2}/.test(linuxPath)) return linuxPath; // 已是 UNC/WSL 主机路径
		// /mnt/c/Users/... → C:\Users\...
		const mntMatch = linuxPath.match(/^\/mnt\/([a-z])\/(.*)/);
		if (mntMatch) {
			return `${mntMatch[1].toUpperCase()}:\\${mntMatch[2].replace(/\//g, "\\")}`;
		}
		// /home/user/... → \\wsl$\<distro>\home\user\...
		const settings = settingsStore.get();
		if (settings.wslEnabled && settings.wslDistro) {
			return `\\\\wsl$\\${settings.wslDistro}\\${linuxPath.replace(/^\//, "").replace(/\//g, "\\")}`;
		}
		return linuxPath;
	};

	const toHostPath = (path: string): string => toWindowsPath(path);
	const authorizePath = (
		path: string,
		operation: string,
		mode: AuthorizedPathMode = "read",
	): Promise<string> =>
		assertAuthorizedFilePath(
			toHostPath(path),
			getAuthorizedRoots().map(toHostPath),
			operation,
			mode,
		);
	const readBase64AtPath = async (hostPath: string, maxBytes?: number): Promise<string> => {
		try {
			// 粘贴图片等场景传入 maxBytes 预检：超大文件在 stat 层拦截，
			// 避免全量读入主进程再经 IPC 传输压垮两侧内存（与 filesReadContent 同一策略）。
			if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0) {
				const fileStat = await stat(hostPath);
				if (fileStat.size > maxBytes) {
					// 结构化前缀供渲染层识别后走回退逻辑；message 不直接展示给用户
					throw new Error(`FILE_TOO_LARGE:${fileStat.size}:${Math.floor(maxBytes)}`);
				}
			}
			// 二进制预览（图片/PDF 等）：读为 base64 由渲染层转 Blob URL 显示。
			// 渲染层对空串（ENOENT）走「不支持」提示。
			const buffer = await readFile(hostPath);
			return buffer.toString("base64");
		} catch (error) {
			if (hasNodeErrorCode(error, "ENOENT")) return "";
			throw error;
		}
	};

	router.handle(ipcChannels.dialogPickFiles, async (options?: { title?: string; includeDirectories?: boolean }) => {
		const result = await dialogs.showOpenDialog({
			// 调用方传入经过 i18n 的标题；缺省时交由系统使用平台默认文案。
			title: options?.title,
			// Qt/Windows 原生选择器不能在一个 picker 中混合文件和目录；
			// includeDirectories 因此是明确的目录选择模式，避免一次调用连续弹出两个不同 picker。
			properties: options?.includeDirectories
				? ["openDirectory"]
				: ["openFile", "multiSelections"],
			parent: "none",
		});
		return result.canceled ? [] : result.filePaths;
	});

	router.handle(ipcChannels.filesList, async (projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const hostProjectPath = await authorizePath(project.path, "list", "read");
		return fileSystemService.listTree(hostProjectPath);
	});

	router.handle(ipcChannels.filesOpen, async (path: string) => {
		const result = await platformShell.openPath(await authorizePath(path, "open", "read"));
		if (!result.ok) throw new Error(result.error);
	});

	router.handle(ipcChannels.filesShowInFolder, async (path: string) => {
		// 回归修复（30b6954b 误删）：渲染层「在文件夹中显示」依赖此通道，
		// 缺失时 invoke 会抛 No handler registered。WSL 路径先转 Windows 再定位。
		platformShell.showItemInFolder(await authorizePath(path, "show-in-folder", "read"));
	});

	router.handle(ipcChannels.filesReadContent, async (path: string, maxBytes?: number) => {
		try {
			const hostPath = await authorizePath(path, "read", "read");
			// 编辑器场景传入 maxBytes（maxEditorFileSizeMB 设置项）：读取前先 stat 拦截，
			// 避免大文件全量读入主进程再经 IPC 传输（几百 MB 字符串会同时压垮两侧内存）。
			// 其他调用方（技能/提示词小文件）不传参，行为不变。
			if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0) {
				const fileStat = await stat(hostPath);
				if (fileStat.size > maxBytes) {
					// 结构化前缀供渲染层识别后走 i18n 文案；message 不直接展示给用户
					throw new Error(`FILE_TOO_LARGE:${fileStat.size}:${Math.floor(maxBytes)}`);
				}
			}
			return await readFile(hostPath, "utf8");
		} catch (error) {
			if (hasNodeErrorCode(error, "ENOENT")) {
				return "";
			}
			throw error;
		}
	});

	router.handle(ipcChannels.filesWriteContent, async (path: string, content: string) => {
		const hostPath = await authorizePath(path, "write", "write");
		await writeFile(hostPath, content, "utf8");
		void appLogger.info("file", "File written", { path, bytes: Buffer.byteLength(content, "utf8") });
	});

	router.handle(ipcChannels.filesReadBase64, async (path: string, maxBytes?: number) => {
		const hostPath = await authorizePath(path, "read-base64", "read");
		return readBase64AtPath(hostPath, maxBytes);
	});

	router.handle(
		ipcChannels.filesReadBase64External,
		async (capabilityId: unknown, path: unknown, maxBytes: unknown) => {
			assertString(capabilityId, "capabilityId");
			assertString(path, "path");
			assertExternalReadLimit(maxBytes);
			const trustedPath = externalFileCapabilities?.consumeRead(capabilityId, toHostPath(path));
			if (!trustedPath) throw new Error("External clipboard file capability is unavailable.");
			return readBase64AtPath(toHostPath(trustedPath), maxBytes);
		},
	);

	router.handle(
		ipcChannels.filesCreate,
		async (parentDir: string, name: string, type: "file" | "directory") => {
			const hostParentDir = await authorizePath(parentDir, "create", "read");
			// Check the final entry too: an existing child symlink must not turn a
			// workspace create into an outside write.
			await authorizePath(join(hostParentDir, name), "create", "write");
			const result = await fileSystemService.create(hostParentDir, name, type);
			void appLogger.info("file", "File/folder created", { parentDir, name, type, result });
			return result;
		},
	);

	router.handle(ipcChannels.filesDelete, async (path: string, recursive?: boolean) => {
		try {
			const hostPath = await authorizePath(path, "delete", "link");
			await fileSystemService.delete(hostPath, recursive);
			void appLogger.info("file", "File deleted", { path, recursive: Boolean(recursive) });
		} catch (error) {
			// 删除失败同样留痕（回收站不可用/权限不足/路径不存在等），
			// 保证"谁发起的删除、为什么没删掉"可事后审计。
			void appLogger.error("file", "File delete failed", {
				path,
				recursive: Boolean(recursive),
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});

	router.handle(ipcChannels.filesRename, async (path: string, newName: string) => {
		const hostPath = await authorizePath(path, "rename", "link");
		await authorizePath(join(dirname(hostPath), newName), "rename", "write");
		const result = await fileSystemService.rename(hostPath, newName);
		void appLogger.info("file", "File renamed", { path, newName, result });
		return result;
	});

	const copyToAuthorizedTarget = async (
		sourcePaths: readonly string[],
		targetDir: string,
		sourceResolver: (sourcePath: string) => Promise<string>,
	): Promise<string[]> => {
		const results: string[] = [];
		for (const src of sourcePaths) {
			try {
				const hostSource = await sourceResolver(src);
				const name = basename(hostSource);
				const dest = await authorizePath(join(targetDir, name), "copy-target", "write");
				// 递归复制目录/文件；同名已存在时跳过覆盖。Node 的 force
				// 默认为 true，必须显式关闭才能让 errorOnExist:false 生效。
				await fsOperations.copy(hostSource, dest, { recursive: true, force: false, errorOnExist: false });
				results.push(dest);
				void appLogger.info("file", "File/folder copied", { src, dest });
			} catch (error) {
				void appLogger.info("file", "File copy failed", { src, targetDir, error: error instanceof Error ? error.message : String(error) });
				throw error;
			}
		}
		return results;
	};

	const copyInternal = async (sourcePaths: unknown, targetDir: unknown): Promise<string[]> => {
		assertStringArray(sourcePaths, "sourcePaths");
		assertString(targetDir, "targetDir");
		const hostTargetDir = await authorizePath(targetDir, "copy-target", "read");
		return copyToAuthorizedTarget(sourcePaths, hostTargetDir, (sourcePath) =>
			authorizePath(sourcePath, "copy-source", "read"));
	};

	// Keep the legacy channel as an internal-only alias. It is deliberately no
	// longer an external-path escape hatch, so old callers fail closed outside roots.
	router.handle(ipcChannels.filesCopy, copyInternal);
	router.handle(ipcChannels.filesCopyInternal, copyInternal);
	router.handle(
		ipcChannels.filesCopyExternal,
		async (capabilityId: unknown, targetDir: unknown) => {
			assertString(capabilityId, "capabilityId");
			assertString(targetDir, "targetDir");
			const hostTargetDir = await authorizePath(targetDir, "copy-target", "read");
			const sourcePaths = externalFileCapabilities?.consumeCopy(capabilityId);
			if (!sourcePaths) throw new Error("External clipboard file capability is unavailable.");
			return copyToAuthorizedTarget(sourcePaths, hostTargetDir, async (sourcePath) => toHostPath(sourcePath));
		},
	);

	router.handle(
		ipcChannels.filesMove,
		async (sourcePaths: string[], targetDir: string) => {
			const hostTargetDir = await authorizePath(targetDir, "move-target", "read");
			const results: string[] = [];
			for (const src of sourcePaths) {
				const hostSource = await authorizePath(src, "move-source", "link");
				try {
					const name = basename(hostSource);
					const dest = await authorizePath(join(hostTargetDir, name), "move-target", "write");
					// 同设备优先 rename（瞬时）；跨设备/跨盘 rename 会报 EXDEV，回退 cp + rm
					try {
						await fsOperations.rename(hostSource, dest);
					} catch (error) {
						// 仅跨设备 rename 才允许 copy+remove。目标冲突、权限和
						// sharing violation 必须原样失败，避免覆盖目标后删除源数据。
						if (!hasNodeErrorCode(error, "EXDEV")) throw error;
						// force 默认是 true；关闭它并要求 errorOnExist，保证目标在
						// copy 前已存在或在竞态中出现时都不会覆盖后删除源文件。
						await fsOperations.copy(hostSource, dest, {
							recursive: true,
							dereference: false,
							force: false,
							errorOnExist: true,
						});
						await fsOperations.remove(hostSource, { recursive: true, force: true });
					}
					results.push(dest);
					void appLogger.info("file", "File/folder moved", { src, dest });
				} catch (error) {
					void appLogger.info("file", "File move failed", { src, targetDir, error: error instanceof Error ? error.message : String(error) });
					throw error;
				}
			}
			return results;
		},
	);

}
