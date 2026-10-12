import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { UnauthorizedFilePathError, type AuthorizedPathMode } from "../fs/authorizedPaths";
import { toWindowsHostPath, WslPathError, type WslEnvironment } from "../wsl/WslPaths";
import { assertDirectPromptFile, assertProjectPromptRoot, assertRegisteredProjectRoot } from "./promptPathAuthorization";

type PromptAuthorizationDeps = {
	getGlobalRoot: () => string;
	getProjectRoots: () => readonly string[];
	getWslEnvironment: () => WslEnvironment | null;
	translate: (key: MainProcessTranslationKey) => string;
};

/** 提示词路径授权 owner：统一 WSL 宿主转换、项目目录归属和权限错误文案。 */
export class PromptPathAuthorizer {
	constructor(private readonly deps: PromptAuthorizationDeps) {}

	private isDenied(error: unknown): boolean {
		return error instanceof UnauthorizedFilePathError || error instanceof TypeError || error instanceof WslPathError;
	}

	/** 转换必须早于 realpath；UNC 校验保留 distro 隔离和 Linux 部分大小写。 */
	private toHostPath(filePath: string): string {
		const environment = this.deps.getWslEnvironment();
		return process.platform === "win32" && environment ? toWindowsHostPath(filePath, environment) : filePath;
	}

	async global(filePath: string, mode: AuthorizedPathMode): Promise<string> {
		try {
			return await assertDirectPromptFile(this.toHostPath(filePath), this.deps.getGlobalRoot(), mode);
		} catch (error) {
			if (!this.isDenied(error)) throw error;
			throw new Error(this.deps.translate(mode === "link" ? "mainPrompt.globalDeleteOnly" : "mainPrompt.globalEditOnly"));
		}
	}

	/** 项目根与模板目录分别授权，不能把中间链接的 realpath 升格为可信根。 */
	async projectDirectory(projectPath: string): Promise<string> {
		try {
			const roots: string[] = [];
			for (const root of this.deps.getProjectRoots()) {
				try { roots.push(this.toHostPath(root)); }
				catch (error) {
					// 其他 distro 的登记项目不是本次授权的根；不能阻止当前 distro 合法项目。
					if (!(error instanceof WslPathError)) throw error;
				}
			}
			const projectRoot = await assertRegisteredProjectRoot(this.toHostPath(projectPath), roots);
			return await assertProjectPromptRoot(projectRoot);
		} catch (error) {
			if (!this.isDenied(error)) throw error;
			throw new Error(this.deps.translate("mainPrompt.notAuthorized"));
		}
	}

	async readable(filePath: string): Promise<string> {
		let hostPath: string;
		try {
			hostPath = this.toHostPath(filePath);
			try {
				return await assertDirectPromptFile(hostPath, this.deps.getGlobalRoot(), "read");
			} catch (error) {
				if (!this.isDenied(error)) throw error;
			}
		} catch (error) {
			if (!this.isDenied(error)) throw error;
			throw new Error(this.deps.translate("mainPrompt.notAuthorized"));
		}
		for (const root of this.deps.getProjectRoots()) {
			try {
				const hostRoot = this.toHostPath(root);
				const projectRoot = await assertRegisteredProjectRoot(hostRoot, [hostRoot]);
				const promptRoot = await assertProjectPromptRoot(projectRoot);
				return await assertDirectPromptFile(hostPath, promptRoot, "read");
			} catch (error) {
				if (!this.isDenied(error)) throw error;
			}
		}
		throw new Error(this.deps.translate("mainPrompt.notAuthorized"));
	}
}
