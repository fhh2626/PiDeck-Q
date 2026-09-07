import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isPathInsideRoot } from "../security/policy";

export const FILE_PATH_NOT_AUTHORIZED_CODE = "FILE_PATH_NOT_AUTHORIZED";

export class UnauthorizedFilePathError extends Error {
	readonly code = FILE_PATH_NOT_AUTHORIZED_CODE;

	constructor(operation: string) {
		super(`File path is not authorized for ${operation}.`);
		this.name = "UnauthorizedFilePathError";
	}
}

/** 判断规范化后的路径是否位于任一授权根目录内。 */
export function isPathWithinAuthorizedRoots(target: string, roots: readonly string[]): boolean {
	if (!target || roots.length === 0) return false;
	const normalizedTarget = resolve(target);
	return roots.some((root) => root.length > 0 && isPathInsideRoot(normalizedTarget, resolve(root)));
}

/** 仅做词法边界检查；真实文件操作必须使用下面的 filesystem-aware assertion。 */
export function assertLexicallyAuthorizedFilePath(
	target: string,
	roots: readonly string[],
	operation: string,
): string {
	const normalizedTarget = resolve(target);
	if (!isPathWithinAuthorizedRoots(normalizedTarget, roots)) {
		throw new UnauthorizedFilePathError(operation);
	}
	return normalizedTarget;
}

export type AuthorizedPathMode = "read" | "write" | "link";

function isMissingPathError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function realpathIfPresent(target: string): Promise<string | null> {
	try {
		return await realpath(target);
	} catch (error) {
		if (isMissingPathError(error)) return null;
		throw error;
	}
}

async function lstatIfPresent(target: string) {
	try {
		return await lstat(target);
	} catch (error) {
		if (isMissingPathError(error)) return null;
		throw error;
	}
}

/**
 * Resolve the nearest existing ancestor and append the missing suffix. This
 * keeps write/create checks safe when the final file does not exist yet while
 * still resolving every existing symlink/junction in the path.
 */
async function realpathWithMissingSuffix(target: string): Promise<string> {
	const missingParts: string[] = [];
	let current = resolve(target);
	while (true) {
		const existing = await realpathIfPresent(current);
		if (existing) return missingParts.reduceRight((parent, part) => join(parent, part), existing);
		const parent = dirname(current);
		if (parent === current) throw new Error(`Cannot resolve path parent: ${target}`);
		missingParts.push(basename(current));
		current = parent;
	}
}

async function resolveAuthorizedRoots(roots: readonly string[]): Promise<string[]> {
	const resolved: string[] = [];
	for (const root of roots) {
		if (!root) continue;
		const realRoot = await realpathIfPresent(resolve(root));
		if (realRoot) resolved.push(realRoot);
	}
	return resolved;
}

/**
 * Filesystem-aware authorization. Lexical containment alone is insufficient:
 * a symlink/junction inside a project can otherwise redirect reads and writes
 * outside the project. Read/write checks resolve the target; link operations
 * validate the real parent and retain the lexical target so deleting/renaming
 * a link does not silently operate on its referent.
 */
export async function assertAuthorizedFilePath(
	target: string,
	roots: readonly string[],
	operation: string,
	mode: AuthorizedPathMode = "read",
): Promise<string> {
	const normalizedTarget = resolve(target);
	const resolvedRoots = await resolveAuthorizedRoots(roots);
	if (resolvedRoots.length === 0) throw new UnauthorizedFilePathError(operation);

	if (mode === "link") {
		const realParent = await realpathWithMissingSuffix(dirname(normalizedTarget));
		if (!resolvedRoots.some((root) => isPathInsideRoot(realParent, root))) {
			throw new UnauthorizedFilePathError(operation);
		}
		// Inspect the final entry without following it. Deleting/renaming a link is
		// intentionally allowed as an operation on that entry; only the parent chain
		// is resolved, so an intermediate junction cannot redirect the operation.
		await lstatIfPresent(normalizedTarget);
		return normalizedTarget;
	}

	const targetStat = await lstatIfPresent(normalizedTarget);
	if (targetStat?.isSymbolicLink()) {
		// Read/write/copy-source never follow a link, even when its current referent
		// happens to be inside a root; this also closes the dangling-link TOCTOU case.
		throw new UnauthorizedFilePathError(operation);
	}
	const existingTarget = await realpathIfPresent(normalizedTarget);
	const containmentTarget = existingTarget ?? await realpathWithMissingSuffix(normalizedTarget);
	if (!resolvedRoots.some((root) => isPathInsideRoot(containmentTarget, root))) {
		throw new UnauthorizedFilePathError(operation);
	}
	return existingTarget ?? normalizedTarget;
}
