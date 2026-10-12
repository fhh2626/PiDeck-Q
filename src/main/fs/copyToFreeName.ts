import { extname, join } from "node:path";
import { copyWithoutOverwrite, type ExclusiveCopyOperations } from "./copyWithoutOverwrite";

/** 最多尝试的候选名数量；超过说明目录里有大量同名副本，直接报错比无限循环安全。 */
const MAX_COPY_NAME_ATTEMPTS = 1000;

/** 生成第 n 个候选名：a.txt → a (1).txt；目录或无扩展名 → name (1)；.env → .env (1)。 */
export function copyCandidateName(name: string, attempt: number): string {
	if (attempt === 0) return name;
	const ext = extname(name);
	const stem = ext ? name.slice(0, -ext.length) : name;
	return `${stem} (${attempt})${ext}`;
}

function isExistsAt(error: unknown, path: string): boolean {
	if (typeof error !== "object" || error === null) return false;
	const e = error as { code?: unknown; path?: unknown; dest?: unknown };
	return e.code === "EEXIST" && (e.path === path || e.dest === path);
}

/**
 * 把 source 复制到 targetDir 下，名字冲突时自动改用 "name (n).ext"。
 * 独占性由 copyWithoutOverwrite 的系统调用保证；只有“顶层目标已存在”才换名重试，
 * 目录内部条目冲突（说明有并发写入者进入了我们刚建的目录）直接抛错，不做清理。
 * 返回实际写入的目标路径。
 */
export async function copyToFreeName(
	source: string,
	targetDir: string,
	name: string,
	operations?: ExclusiveCopyOperations,
): Promise<string> {
	for (let attempt = 0; attempt < MAX_COPY_NAME_ATTEMPTS; attempt++) {
		const candidate = join(targetDir, copyCandidateName(name, attempt));
		try {
			await copyWithoutOverwrite(source, candidate, operations);
			return candidate;
		} catch (error) {
			if (isExistsAt(error, candidate)) continue;
			throw error;
		}
	}
	throw new Error(`COPY_NAME_EXHAUSTED: ${name}`);
}
