import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 文本驻留契约：工具结果截断下发 + 「查看完整输出」按需读取链路
const projector = readFileSync("src/main/pi/AgentMessageProjector.ts", "utf8");
const agentUtils = readFileSync("src/main/pi/agentUtils.ts", "utf8");
const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const reader = readFileSync("src/main/pi/SessionHistoryReader.ts", "utf8");
const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const preload = readFileSync("src/shared/desktop/createPiDesktopApi.ts", "utf8");
const toolCard = readFileSync(
  "src/renderer/src/components/session/ToolCallComponents.tsx",
  "utf8",
);

test("tool detail is delivered with truncated/fullLength markers", () => {
  // detailText 整体截断（拼接后可能超单段上限），并带截断标记供渲染层展示按需加载入口
  assert.match(projector, /truncateDetailWithMeta\(text: string\)/);
  assert.match(projector, /return \{ text, truncated: false, fullLength: text\.length \};/);
  assert.match(projector, /truncated: true,\n\t\t\tfullLength: text\.length,/);
  // history 分支写入标记
  assert.match(projector, /detailText: detailDelivery\.text,/);
  assert.match(
    projector,
    /\? \{ truncated: true, fullLength: detailDelivery\.fullLength \}/,
  );
});

test("runtime tool path caches full text for on-demand read", () => {
  // 运行期完整结果只进按 agent 隔离的 LRU 缓存，截断版进 meta
  assert.match(agentManager, /private readonly toolFullTextByAgent = new Map<string, Map<string, string>>\(\);/);
  assert.match(agentManager, /TOOL_FULL_TEXT_LRU_LIMIT = 200/);
  assert.match(agentManager, /if \(detailDelivery\.truncated\)/);
  assert.match(agentManager, /fullTextCache\.set\(messageId, fullText\);/);
  // agent 停止时只释放当前 agent 的缓存
  assert.match(agentManager, /this\.toolFullTextByAgent\.delete\(agentId\);/);
  assert.doesNotMatch(agentManager, /toolFullTextByMessageId\.clear\(\);/);
});

test("delivery strips redundant meta.result from tool messages", () => {
  // 下发瘦身：meta.result 与 detailText 重复（渲染层从不读取 result），只在 IPC 边界剥离
  assert.match(agentUtils, /export function stripToolResultForDelivery\(messages: ChatMessage\[\]\)/);
  assert.match(agentUtils, /delete meta\.result;/);
  // 全部下发出口统一剥离：flush 两个分支 + getMessageWindow + disk 分页 facade
  assert.match(agentUtils, /stripToolResultForDelivery\(all\.slice\(dirtyFrom\)\)/);
  assert.match(agentUtils, /stripToolResultForDelivery\(all\.slice\(boundedWindow\)\)/);
  assert.match(agentManager, /stripToolResultForDelivery\(\[\.\.\.summaryCards, \.\.\.all\.slice\(windowStart\)\]\)/);
  assert.match(agentManager, /stripToolResultForDelivery\(page\.messages\)/);
});

test("full text read falls back to session file with LRU cache", () => {
  // 主进程：内存缓存优先，回退会话文件定位读取（不整文件转换）
  assert.match(agentManager, /async readMessageFullText\(/);
  assert.match(agentManager, /this\.toolFullTextByAgent\.get\(agentId\)\?\.get\(messageId\)/);
  assert.match(agentManager, /this\.sessionHistoryReader\.readMessageFullText\(sessionPath, messageId, entryId\)/);
  // 文件读取：逐行 parse 定位（entryId 优先，回退 message.id），LRU 200
  assert.match(reader, /async readMessageFullText\(/);
  assert.match(reader, /entryId && e\.id === entryId/);
  assert.match(reader, /FULL_TEXT_CACHE_LIMIT = 200/);
});

test("agent cleanup removes every per-agent cache without clearing sibling output", () => {
  assert.match(agentManager, /this\.toolStateSequenceByAgent\.delete\(agentId\);/);
  assert.match(agentManager, /this\.activeToolCallsByAgent\.delete\(agentId\);/);
  assert.match(agentManager, /this\.toolExecutingByAgent\.delete\(agentId\);/);
  assert.match(agentManager, /this\.messageDirtyFromByAgent\.delete\(agentId\);/);
  assert.match(agentManager, /this\.displayWindowStartByAgent\.delete\(agentId\);/);
  assert.match(agentManager, /this\.messageHeadOffsetByAgent\.delete\(agentId\);/);
  assert.match(agentManager, /this\.pendingSlideOutByAgent\.delete\(agentId\);/);
  assert.match(agentManager, /this\.sessionFileVersionByAgent\.delete\(agentId\);/);
  assert.match(agentManager, /this\.promptRequestedAtByAgent\.delete\(agentId\);/);
});

test("IPC channel, handler and preload surface are wired", () => {
  assert.match(ipc, /sessionsCatalogReadMessageFullText: "sessions:catalog-read-message-full-text"/);
  assert.match(
    readFileSync("src/main/ipc/sessionIpc.ts", "utf8"),
    /ipcChannels\.sessionsCatalogReadMessageFullText,/,
  );
  // 四参签名：sessionId 用于运行期绑定不可用时的历史会话文件回退（_viewer 投影）
  assert.match(
    preload,
    /readMessageFullText: \(\s*sessionId: string \| undefined,\s*agentId: string,\s*messageId: string,\s*entryId\?: string,\s*\)/,
  );
  // handler 侧：运行期路径失败时回退 catalog filePath 定位
  assert.match(
    readFileSync("src/main/ipc/sessionIpc.ts", "utf8"),
    /readMessageFullTextFromFile\(\s*record\.filePath,\s*messageId,\s*entryId as string \| undefined,\s*\)/,
  );
});

test("ToolCard shows on-demand full-output entry with loading/error states", () => {
  // 截断标记驱动入口；加载成功替换显示文本，失败保留重试
  assert.match(toolCard, /isTruncated = props\.message\.meta\?\.truncated === true/);
  assert.match(toolCard, /desktopApi\.sessions\.readMessageFullText\(/);
  assert.match(toolCard, /setFullText\(result\.text\)/);
  assert.match(toolCard, /setFullError\(true\)/);
  assert.match(toolCard, /fullOutputLoadFailed/);
});
