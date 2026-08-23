import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 内置对话区（Chat）「切换聊天记录保存目录」入口：侧栏父项目行 → App 层 changeChatPath
// （弹目录选择器 → 主进程写 chat-path.json → 重扫会话 → toast）。IPC 链路（choose-chat-path
// / set-chat-path）已有主进程实现与 preload 暴露，此处断言渲染层接线完整、无重复入口。

test("ChatDirectoryButton exists and gates on chat projects only", () => {
	const source = readFileSync("src/renderer/src/components/session/ChatDirectoryButton.tsx", "utf8");
	// 组件按「会话所属项目」判定，非 chat 项目不渲染（避免与普通项目的目录管理重复抢占）
	assert.match(source, /export function ChatDirectoryButton\(props: \{ sessionId: string \}\)/);
	assert.match(source, /sessionRecordByIdAtomFamily\(props\.sessionId\)/);
	assert.match(source, /projectByIdAtomFamily\(session\?\.projectId \?\? ""\)/);
	assert.match(source, /if \(!session \|\| !isChatProject\(project\)\) return null/);
});

test("ChatDirectoryButton reuses the App-level changeChatPath service", () => {
	const source = readFileSync("src/renderer/src/components/session/ChatDirectoryButton.tsx", "utf8");
	// changeChatPath/showNotice 是稳定回调，只订 actions 轨（拆分后不再被 terminal/gitInfo 变化唤醒）
	assert.match(source, /useSessionPaneActions\(\)/);
	assert.match(source, /\{ changeChatPath, showNotice \}/);
	assert.match(source, /void changeChatPath\(project\)\.catch/);
	// 图标入口语义：目录图标 + i18n 文案
	assert.match(source, /FolderCog/);
	assert.match(source, /t\("app\.chatProjectSettings"\)/);
});

test("SessionView keeps directory settings out of the header actions slot", () => {
	const source = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
	assert.doesNotMatch(source, /ChatDirectoryButton/);
	assert.match(source, /SessionWidgetChips/);
});

test("App extracts changeChatPath once and injects it into the sidebar action", () => {
	const source = readFileSync("src/renderer/src/App.tsx", "utf8");
	const projectCommands = readFileSync("src/renderer/src/hooks/useProjectCommands.ts", "utf8");
	// 项目命令 hook 只实现一次，App 同时注入侧栏与会话服务。
	assert.match(projectCommands, /async function changeChatPath\(project: Project\)/);
	assert.match(source, /changeChatPath,[\s\S]*= useProjectCommands\(/);
	// 侧边栏 projects action 引用同一实现
	assert.match(source, /changeChatPath,\n    \},/);
	// sessionPaneServices 注入 + 依赖数组包含（闭包不陈旧）
	assert.match(source, /changeChatPath,\n      jumpToMessageRef,/);
	assert.match(source, /changeChatPath,\n/);
});

test("SessionPaneServices declares changeChatPath contract", () => {
	const source = readFileSync("src/renderer/src/components/session/SessionPaneServices.tsx", "utf8");
	assert.match(source, /changeChatPath: \(project: Project\) => Promise<void>;/);
});

test("chat directory i18n keys exist in zh-CN and en-US", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	for (const key of ["app.chatProjectSettings", "app.chatProjectPathUpdated"]) {
		assert.match(zh, new RegExp(`"${key}":`), `zh-CN missing ${key}`);
		assert.match(en, new RegExp(`"${key}":`), `en-US missing ${key}`);
	}
});
