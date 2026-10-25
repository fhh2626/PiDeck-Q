import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

/**
 * 在当前测试文件里创建会被自动清理的临时目录。
 *
 * 只靠测试体末尾的 rmSync 清理时，断言先失败就会跳过清理，系统临时目录里留下垃圾；
 * 这里统一在文件级 `after` 钩子里兜底删除。必须在测试文件（或被它导入的 helper）的
 * 顶层调用，因为 `after` 依赖 node:test 的文件级上下文。返回 `makeTempDir(prefix)`。
 */
export function trackedTempDirs() {
	const dirs = [];
	after(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
	});
	return (prefix) => {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		dirs.push(dir);
		return dir;
	};
}