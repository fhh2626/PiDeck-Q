import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const scanner = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");
// E1：会话记录删除已收口到 SessionRecordService（桌面 IPC 与 Web 的唯一实现），
// 原来断言 sessionIpc 内部实现细节的写法会随着重构失效，改为断言服务本身。
const recordService = readFileSync("src/main/sessions/SessionRecordService.ts", "utf8");

test("session file deletion treats an already missing local file as success", () => {
  assert.match(scanner, /if \(!existsSync\(filePath\)\) return;/);
  // 删除走系统回收站（可恢复）；回收站不可用时抛错，拒绝静默硬删。
  assert.match(scanner, /await this\.trashPath\(filePath/);
});

test("catalog delete still removes the catalog record after a stale file path", () => {
  assert.match(recordService, /if \(entry\.filePath\) await this\.deps\.sessionScanner\.delete\(entry\.filePath\)/);
  assert.match(recordService, /await this\.deps\.sessionCatalog\.remove\(sessionId\)/);
});
