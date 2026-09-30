import { copyFile, cp, lstat, mkdir, readFile, rename as fsRename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { copyWithoutOverwrite, UnsupportedExclusiveCopyFileTypeError, type ExclusiveCopyOperations } from "../fs/copyWithoutOverwrite";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import type { PickImagesResult } from "../../shared/types";
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

function isWindowsPathSemantics(): boolean {
	return globalThis.process?.platform === "win32";
}

function sameMovePath(left: string, right: string): boolean {
	const a = resolve(left);
	const b = resolve(right);
	return isWindowsPathSemantics() ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isPathInside(parent: string, candidate: string): boolean {
	const rel = relative(resolve(parent), resolve(candidate));
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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

export type FilesIpcFileOperations = ExclusiveCopyOperations & {
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
	mainCopy?: (key: MainProcessTranslationKey) => string;
	/** Capabilities issued by the trusted native clipboard/drop boundary. */
	externalFileCapabilities?: Pick<ExternalFileCapabilityStore, "consumeCopy" | "consumeRead" | "issuePicker">;
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
		mainCopy = (key) => key,
		externalFileCapabilities,
		fileOperations,
	}: FilesIpcDeps,
): void {
	const fsOperations: FilesIpcFileOperations = {
		rename: fileOperations?.rename ?? fsRename,
		copy: fileOperations?.copy ?? cp,
		remove: fileOperations?.remove ?? rm,
		copyFile: fileOperations?.copyFile ?? copyFile,
		mkdir: fileOperations?.mkdir ?? mkdir,
		symlink: fileOperations?.symlink ?? symlink,
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
			if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0 && buffer.byteLength > maxBytes) {
				throw new Error(`FILE_TOO_LARGE:${buffer.byteLength}:${Math.floor(maxBytes)}`);
			}
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

	router.handle(ipcChannels.dialogPickImages, async (rawOptions?: unknown): Promise<PickImagesResult> => {
		try {
			let title: string | undefined = undefined;
			if (rawOptions && typeof rawOptions === "object") {
				const opts = rawOptions as Record<string, unknown>;
				if (typeof opts.title === "string" && opts.title.trim()) {
					title = opts.title.trim();
				}
			}
			const result = await dialogs.showOpenDialog({
				title,
				properties: ["openFile", "multiSelections"],
				filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
				parent: "none",
			});
			if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
				return { kind: "cancelled" };
			}
			const uniquePaths: string[] = [];
			const seen = new Set<string>();
			for (const path of result.filePaths) {
				if (typeof path === "string" && path.length > 0 && !seen.has(path)) {
					seen.add(path);
					uniquePaths.push(path);
				}
			}
			if (uniquePaths.length === 0) {
				return { kind: "cancelled" };
			}
			if (uniquePaths.length > 16) {
				return { kind: "error", code: "TOO_MANY_FILES" };
			}
			const capabilityId = externalFileCapabilities?.issuePicker(uniquePaths);
			if (!capabilityId) {
				return { kind: "error", code: "PICKER_FAILED" };
			}
			return { kind: "selected", capabilityId, paths: uniquePaths };
		} catch (error) {
			void appLogger.error("file", "Pick images dialog failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return { kind: "error", code: "PICKER_FAILED" };
		}
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
		async (parentDir: unknown, name: unknown, type: unknown) => {
			assertString(parentDir, "parentDir");
			assertString(name, "name");
			if (type !== "file" && type !== "directory") {
				throw new TypeError("type must be file or directory.");
			}
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
		async (sourcePaths: unknown, targetDir: unknown) => {
			assertStringArray(sourcePaths, "sourcePaths");
			assertString(targetDir, "targetDir");
			const hostTargetDir = await authorizePath(targetDir, "move-target", "read");
			const planned: Array<{ src: string; hostSource: string; dest: string }> = [];
			const destinations = new Set<string>();
			for (const src of sourcePaths) {
				const hostSource = await authorizePath(src, "move-source", "link");
				const dest = await authorizePath(join(hostTargetDir, basename(hostSource)), "move-target", "write");
				const key = isWindowsPathSemantics() ? dest.toLowerCase() : dest;
				if (destinations.has(key)) throw new Error(`Destination already exists: ${dest}`);
				destinations.add(key);
				planned.push({ src, hostSource, dest });
			}
			const results: string[] = [];
			for (const move of planned) {
				try {
					if (sameMovePath(move.hostSource, move.dest)) {
						results.push(move.dest);
						continue;
					}
					const sourceStat = await lstat(move.hostSource);
					if (sourceStat.isDirectory() && isPathInside(move.hostSource, move.dest)) {
						throw new Error("Cannot move a directory into itself");
					}
					// rename 在 Windows 同盘会直接替换已有文件，且检查后再 rename 仍有竞态。
					// 独占创建每个目标条目，源只在整个树复制成功后删除。
					try {
						await lstat(move.dest);
						throw new Error(`Destination already exists: ${move.dest}`);
					} catch (error) {
						if (error instanceof Error && error.message.startsWith("Destination already exists")) throw error;
						if (!hasNodeErrorCode(error, "ENOENT")) throw error;
					}
					await copyWithoutOverwrite(move.hostSource, move.dest, fsOperations);
					await fsOperations.remove(move.hostSource, { recursive: true, force: true });
					results.push(move.dest);
					void appLogger.info("file", "File/folder moved", { src: move.src, dest: move.dest });
				} catch (error) {
					void appLogger.info("file", "File move failed", { src: move.src, targetDir, error: error instanceof Error ? error.message : String(error) });
					if (error instanceof UnsupportedExclusiveCopyFileTypeError) {
						throw new Error(mainCopy("mainFile.unsupportedMoveType"));
					}
					throw error;
				}
			}
			return results;
		},
	);

}
