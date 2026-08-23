import { cp, readFile, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import type { FileSystemService } from "../fs/FileSystemService";
import { assertAuthorizedFilePath, isPathWithinAuthorizedRoots } from "../fs/authorizedPaths";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AppLogger } from "../logging/AppLogger";
import type { RpcRouter } from "../transport/RpcRouter";
import type { PlatformDialogs, PlatformShell } from "../platform/PlatformServices";

export type FilesIpcDeps = {
	fileSystemService: FileSystemService;
	projectStore: ProjectStore;
	settingsStore: SettingsStore;
	appLogger: Pick<AppLogger, "info" | "error">;
	dialogs: PlatformDialogs;
	platformShell: Pick<PlatformShell, "openPath" | "showItemInFolder">;
	openExternalUrl: (url: string, forceSystem?: boolean) => Promise<void>;
	getAuthorizedRoots: () => string[];
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
		openExternalUrl,
		getAuthorizedRoots,
	}: FilesIpcDeps,
): void {
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
	const authorizePath = (path: string, operation: string): string =>
		assertAuthorizedFilePath(
			toHostPath(path),
			getAuthorizedRoots().map(toHostPath),
			operation,
		);
	const resolveBase64Path = (path: string, maxBytes: number | undefined): string => {
		const hostPath = toHostPath(path);
		const roots = getAuthorizedRoots().map(toHostPath);
		if (isPathWithinAuthorizedRoots(hostPath, roots)) return hostPath;
		// Clipboard image paste intentionally accepts a file outside the workspace;
		// keep that exception read-only, extension-limited and size-bounded.
		const externalPreviewExtensions = new Set([".avif", ".bmp", ".gif", ".heic", ".jpeg", ".jpg", ".pdf", ".png", ".tif", ".tiff", ".webp"]);
		if (
			typeof maxBytes === "number" &&
			Number.isFinite(maxBytes) &&
			maxBytes > 0 &&
			maxBytes <= 10 * 1024 * 1024 &&
			externalPreviewExtensions.has(extname(hostPath).toLowerCase())
		) {
			return hostPath;
		}
		return assertAuthorizedFilePath(hostPath, roots, "read-base64");
	};

	router.handle(ipcChannels.dialogPickFiles, async (options?: { title?: string; includeDirectories?: boolean }) => {
		const result = await dialogs.showOpenDialog({
			// 调用方传入经过 i18n 的标题；缺省时交由系统使用平台默认文案。
			title: options?.title,
			// Windows 上 openFile 与 openDirectory 并存会退化为「只选文件夹」（FOS_PICKFOLDERS），
			// 附件引用场景以选文件为主，默认只开文件；目录选择由调用方显式开启。
			properties: options?.includeDirectories
				? ["openFile", "openDirectory", "multiSelections"]
				: ["openFile", "multiSelections"],
			parent: "none",
		});
		return result.canceled ? [] : result.filePaths;
	});

	router.handle(ipcChannels.filesList, async (projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		return fileSystemService.listTree(project.path);
	});

	router.handle(ipcChannels.filesOpen, async (path: string) => {
		const result = await platformShell.openPath(authorizePath(path, "open"));
		if (!result.ok) throw new Error(result.error);
	});

	router.handle(ipcChannels.filesShowInFolder, async (path: string) => {
		// 回归修复（30b6954b 误删）：渲染层「在文件夹中显示」依赖此通道，
		// 缺失时 invoke 会抛 No handler registered。WSL 路径先转 Windows 再定位。
		platformShell.showItemInFolder(authorizePath(path, "show-in-folder"));
	});

	router.handle(ipcChannels.browserOpenExternal, async (url: string) => {
		// This IPC is renderer-callable, so it must share the protocol gate used by
		// every other external-link path instead of passing arbitrary schemes to the OS.
		await openExternalUrl(url, true);
	});

	router.handle(ipcChannels.filesReadContent, async (path: string, maxBytes?: number) => {
		try {
			// 编辑器场景传入 maxBytes（maxEditorFileSizeMB 设置项）：读取前先 stat 拦截，
			// 避免大文件全量读入主进程再经 IPC 传输（几百 MB 字符串会同时压垮两侧内存）。
			// 其他调用方（技能/提示词小文件）不传参，行为不变。
			if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0) {
				const fileStat = await stat(authorizePath(path, "read"));
				if (fileStat.size > maxBytes) {
					// 结构化前缀供渲染层识别后走 i18n 文案；message 不直接展示给用户
					throw new Error(`FILE_TOO_LARGE:${fileStat.size}:${Math.floor(maxBytes)}`);
				}
			}
			return await readFile(authorizePath(path, "read"), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return "";
			}
			throw error;
		}
	});

	router.handle(ipcChannels.filesWriteContent, async (path: string, content: string) => {
		await writeFile(authorizePath(path, "write"), content, "utf8");
		void appLogger.info("file", "File written", { path, bytes: Buffer.byteLength(content, "utf8") });
	});

	router.handle(ipcChannels.filesReadBase64, async (path: string, maxBytes?: number) => {
		try {
			// 粘贴图片等场景传入 maxBytes 预检：超大文件在 stat 层拦截，
			// 避免全量读入主进程再经 IPC 传输压垮两侧内存（与 filesReadContent 同一策略）。
			if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0) {
				const fileStat = await stat(resolveBase64Path(path, maxBytes));
				if (fileStat.size > maxBytes) {
					// 结构化前缀供渲染层识别后走回退逻辑；message 不直接展示给用户
					throw new Error(`FILE_TOO_LARGE:${fileStat.size}:${Math.floor(maxBytes)}`);
				}
			}
			// 二进制预览（图片/PDF 等）：读为 base64 由渲染层转 Blob URL 显示。
			// 渲染层对空串（ENOENT）走「不支持」提示。
			const buffer = await readFile(resolveBase64Path(path, maxBytes));
			return buffer.toString("base64");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return "";
			}
			throw error;
		}
	});

	router.handle(
		ipcChannels.filesCreate,
		async (parentDir: string, name: string, type: "file" | "directory") => {
			const result = await fileSystemService.create(authorizePath(parentDir, "create"), name, type);
			void appLogger.info("file", "File/folder created", { parentDir, name, type, result });
			return result;
		},
	);

	router.handle(ipcChannels.filesDelete, async (path: string, recursive?: boolean) => {
		try {
			const hostPath = authorizePath(path, "delete");
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
		const hostPath = authorizePath(path, "rename");
		assertAuthorizedFilePath(join(dirname(hostPath), newName), getAuthorizedRoots().map(toHostPath), "rename");
		const result = await fileSystemService.rename(hostPath, newName);
		void appLogger.info("file", "File renamed", { path, newName, result });
		return result;
	});

	router.handle(
		ipcChannels.filesCopy,
		async (sourcePaths: string[], targetDir: string) => {
			const hostTargetDir = authorizePath(targetDir, "copy-target");
			const results: string[] = [];
			for (const src of sourcePaths) {
				try {
					const hostSource = toHostPath(src);
					const name = basename(hostSource);
					const dest = join(hostTargetDir, name);
					// 递归复制目录/文件；同名已存在时跳过覆盖（errorOnExist: false 反而报错，
					// 这里语义为「已存在则不重复复制」——与资源管理器粘贴行为一致）
					await cp(hostSource, dest, { recursive: true, errorOnExist: false });
					results.push(dest);
					void appLogger.info("file", "File/folder copied", { src, dest });
				} catch (error) {
					void appLogger.info("file", "File copy failed", { src, targetDir, error: error instanceof Error ? error.message : String(error) });
					throw error;
				}
			}
			return results;
		},
	);

	router.handle(
		ipcChannels.filesMove,
		async (sourcePaths: string[], targetDir: string) => {
			const hostTargetDir = authorizePath(targetDir, "move-target");
			const results: string[] = [];
			for (const src of sourcePaths) {
				const hostSource = authorizePath(src, "move-source");
				try {
					const name = basename(hostSource);
					const dest = join(hostTargetDir, name);
					// 同设备优先 rename（瞬时）；跨设备/跨盘 rename 会报 EXDEV，回退 cp + rm
					try {
						await fsRename(hostSource, dest);
					} catch {
						await cp(hostSource, dest, { recursive: true });
						await rm(hostSource, { recursive: true, force: true });
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
