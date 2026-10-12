import { lstat, realpath } from "node:fs/promises";
import { parseWslUncPath } from "../wsl/WslPaths";
import { isPathInsideRoot } from "../security/policy";
import { basename, dirname, join, resolve } from "node:path";
import {
	assertAuthorizedFilePath,
	UnauthorizedFilePathError,
	type AuthorizedPathMode,
} from "../fs/authorizedPaths";

function isMissingPathError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function samePath(left: string, right: string): boolean {
	const a = parseWslUncPath(left);
	const b = parseWslUncPath(right);
	if (a || b) {
		return Boolean(a && b && a.distro.toLowerCase() === b.distro.toLowerCase() && a.linuxPath === b.linuxPath);
	}
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Windows UNC 的 host/distro 不区分大小写，但 WSL 文件系统中的目录名必须精确匹配。 */
function isInsidePromptProject(target: string, root: string): boolean {
	const a = parseWslUncPath(target);
	const b = parseWslUncPath(root);
	if (a || b) {
		if (!a || !b || a.distro.toLowerCase() !== b.distro.toLowerCase()) return false;
		const prefix = b.linuxPath.endsWith("/") ? b.linuxPath : `${b.linuxPath}/`;
		return a.linuxPath === b.linuxPath || a.linuxPath.startsWith(prefix);
	}
	return isPathInsideRoot(target, root);
}

/** 模板文件名只能是模板目录中的一个条目，不能携带路径或穿越片段。 */
export function assertSinglePromptFileName(fileName: unknown): string {
	if (typeof fileName !== "string") throw new TypeError("Prompt file name must be a string.");
	const name = fileName.trim();
	if (
		!name ||
		name === "." ||
		name === ".." ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes("\0") ||
		basename(name) !== name
	) {
		throw new UnauthorizedFilePathError("prompt-file-name");
	}
	return name;
}

async function existingRealPath(target: string): Promise<string | null> {
	try {
		return await realpath(target);
	} catch (error) {
		if (isMissingPathError(error)) return null;
		throw error;
	}
}

/**
 * 授权一个直接位于模板根目录中的 Markdown 文件。
 * 读/写不跟随符号链接；删除使用 link 模式，只删除目录项本身。
 */
export async function assertDirectPromptFile(
	filePath: string,
	root: string,
	mode: AuthorizedPathMode,
): Promise<string> {
	if (typeof filePath !== "string" || filePath.length === 0) {
		throw new TypeError("Prompt path must be a non-empty string.");
	}
	const rootReal = await existingRealPath(resolve(root));
	if (!rootReal) throw new UnauthorizedFilePathError("prompt");
	const authorized = await assertAuthorizedFilePath(filePath, [rootReal], "prompt", mode);
	const parentReal = await existingRealPath(dirname(resolve(filePath)));
	if (!parentReal || !samePath(parentReal, rootReal)) {
		throw new UnauthorizedFilePathError("prompt");
	}
	const name = basename(resolve(filePath));
	if (!name.endsWith(".md") || name.endsWith(".d.md")) {
		throw new UnauthorizedFilePathError("prompt");
	}
	return authorized;
}

/** 验证中间目录的真实归属，不能把指向外部的 prompts realpath 当作新的可信根。 */
export async function assertProjectPromptRoot(projectRoot: string): Promise<string> {
	const rootReal = await existingRealPath(resolve(projectRoot));
	if (!rootReal) throw new UnauthorizedFilePathError("prompt-project");
	const piPath = join(rootReal, ".pi");
	const piReal = await existingRealPath(piPath);
	const piInfo = await lstat(piPath).catch((error: unknown) => {
		if (isMissingPathError(error)) return null;
		throw error;
	});
	// 允许项目内的有效中间链接；悬空链接或指向外部/大小写不同 WSL 目录的链接不获授权。
	if ((piInfo?.isSymbolicLink() && !piReal) || (piReal && !isInsidePromptProject(piReal, rootReal))) {
		throw new UnauthorizedFilePathError("prompt-project");
	}
	const authorized = await assertAuthorizedFilePath(
		join(rootReal, ".pi", "prompts"), [rootReal], "prompt-project", "write",
	);
	const promptsReal = await existingRealPath(authorized);
	if (promptsReal && !isInsidePromptProject(promptsReal, rootReal)) {
		throw new UnauthorizedFilePathError("prompt-project");
	}
	return authorized;
}

/** 项目提示词只接受已登记项目的根目录，不接受其子目录或未登记路径。 */
export async function assertRegisteredProjectRoot(
	projectPath: string,
	roots: readonly string[],
): Promise<string> {
	if (typeof projectPath !== "string" || projectPath.length === 0) {
		throw new TypeError("Project path must be a non-empty string.");
	}
	const existingRoots: string[] = [];
	for (const root of roots) {
		if (typeof root !== "string" || root.length === 0) continue;
		const realRoot = await existingRealPath(resolve(root));
		if (realRoot) existingRoots.push(realRoot);
	}
	if (existingRoots.length === 0) throw new UnauthorizedFilePathError("prompt-project");
	const authorized = await assertAuthorizedFilePath(projectPath, existingRoots, "prompt-project", "read");
	if (!existingRoots.some((root) => samePath(root, authorized))) {
		throw new UnauthorizedFilePathError("prompt-project");
	}
	return authorized;
}
