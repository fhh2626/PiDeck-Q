import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// E1：会话记录删除已收口到 SessionRecordService（桌面 IPC 与 Web 的唯一实现）。
const recordService = readFileSync("src/main/sessions/SessionRecordService.ts", "utf8");

/**
 * H4：删除路径的「不因文件已消失而失败」已由行为测试覆盖，
 * 这里不重复。
 * - 本地文件删除的幂等与回收站调用次数：tests/sessionDeleteLocalBehavior.test.mjs
 *   （deleting an already missing local session is a no-op and never errors /
 *   deleting a local session hands the file to the trash exactly once）
 * - WSL 软删除且绝不 rm：tests/sessionDeleteWslSoft.test.mjs（A4）
 * - catalog 记录清理后广播刷新：tests/sessionRecordService.test.mjs
 *   （delete removes the file, then broadcasts a refresh for the project）
 *
 * 保留唯一一条源码约束：删除失败时不得把 catalog 记录一起丢掉。
 * 这条是「先删文件再删记录」的顺序契约，行为测试的 stub 无法表达顺序失败，
 * 因此仍以源码断言守住（它保护的不是运行时巧合，而是顺序本身）。
 */
test("catalog delete keeps the record when the file delete fails first", () => {
	// 文件删除在前、记录删除在后：文件删除抛错时整个操作中断，记录不会被孤立移除。
	const deleteBody = recordService.slice(
		recordService.indexOf("async delete(sessionId: string)"),
		recordService.indexOf("async delete(sessionId: string)") + 1200,
	);
	assert.ok(deleteBody, "SessionRecordService.delete 必须存在");
	const fileDeleteAt = deleteBody.indexOf("sessionScanner.delete");
	const recordRemoveAt = deleteBody.indexOf("sessionCatalog.remove");
	assert.notEqual(fileDeleteAt, -1, "必须先删除会话文件");
	assert.notEqual(recordRemoveAt, -1, "必须再删除 catalog 记录");
	assert.ok(
		fileDeleteAt < recordRemoveAt,
		"顺序契约：先删文件再删记录，文件删除失败时不得留下无记录的孤儿文件",
	);
});
