import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// ===== 失败/重试提示 → toast 的渲染层改动 =====

test("floating failure keys: covers retry + failure diagnostics, excludes pi start failure", () => {
	const source = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	const keys = [
		"diagnostic.requestFailed",
		"diagnostic.requestFailedAfterRetries",
		"diagnostic.requestFailedUnknown",
		"diagnostic.requestFailedUnknownAfterRetries",
		"diagnostic.agentStopped",
		"diagnostic.promptRejected",
		"diagnostic.promptDeliveryUnknown",
		"diagnostic.commandFailed",
		"diagnostic.commandDeliveryUnknown",
		"diagnostic.commandCancelled",
		"diagnostic.processReconnectFailed",
		"diagnostic.historyLoadFailed",
		"diagnostic.extensionError",
		"diagnostic.retryScheduled",
		"diagnostic.retryScheduledAfterDelay",
		"diagnostic.retrySucceeded",
		"diagnostic.retryFailed",
	];
	for (const key of keys) {
		assert.match(source, new RegExp(`"${key}"`), `missing ${key} in FLOATING_FAILURE_KEYS`);
	}
	// pi 启动失败提示（含排查诊断）必须保留卡片，不能进 Set
	assert.doesNotMatch(source, /"diagnostic\.agentStartFailed"/);
	// 运行时错误同样带完整诊断（buildStartupFailureMessage），保留卡片
	assert.doesNotMatch(source, /"diagnostic\.runtimeError"/);
});

test("floating failure helper: guards non-string meta and uses i18nKey", () => {
	const source = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	assert.match(source, /function isFloatingFailureMessage\(message: ChatMessage\): boolean/);
	assert.match(source, /FLOATING_FAILURE_KEYS\.has\(key\)/);
});

test("timeline render: failure/retry messages return null, diagnostics kept", () => {
	const source = readFileSync("src/renderer/src/components/session/timeline/TimelineMessageRow.tsx", "utf8");
	// error 分支：失败类不渲染卡片（已转 toast）
	assert.match(source, /if \(message\.role === "error"\) \{\s*if \(isFloatingFailureMessage\(message\)\) return null;/s);
	assert.match(source, /if \(isFloatingFailureMessage\(message\)\) return null;/);
	// system 分支：自动重试状态同样转 toast，其他诊断卡片保留
	assert.match(source, /if \(isFloatingFailureMessage\(message\)\) return null;/);
});

test("toast effect: baseline on load completion, only new failures toast", () => {
	const source = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	assert.match(source, /const failureBaselineRef = useRef<string\[\] \| null>\(null\);/);
	assert.match(source, /if \(isConversationLoading\) \{\s*failureBaselineRef\.current = null;/s);
	assert.match(source, /failureBaselineRef\.current = floating\.map\(\(message\) => message\.id\);/);
	assert.match(source, /toastedFailureIds\.has\(message\.id\)/);
	assert.match(source, /markFailureToastShown\(message\.id\);/);
	assert.match(source, /showFailureToast\(message\);/);
	// 模块级 Set：分屏多栏同一条消息只弹一次
	assert.match(source, /const toastedFailureIds = new Set<string>\(\);/);
});

test("showFailureToast: retry uses info kind, failure uses error kind", () => {
	const source = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	assert.match(source, /const isRetry = key\.startsWith\("diagnostic\.retry"\);/);
	assert.match(source, /translateI18nDescriptor\(meta, message\.text\)/);
	assert.match(source, /isRetry \? 4000 : 6000/);
	assert.match(source, /isRetry \? "info" : "error"/);
	assert.match(source, /t\(isRetry \? "diagnostic\.retryToastTitle" : "diagnostic\.failureToastTitle"\)/);
});

test("failure toast i18n keys exist in zh-CN and en-US", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	assert.match(zh, /"diagnostic\.failureToastTitle": "会话失败"/);
	assert.match(zh, /"diagnostic\.retryToastTitle": "自动重试"/);
	assert.match(en, /"diagnostic\.failureToastTitle": "Session error"/);
	assert.match(en, /"diagnostic\.retryToastTitle": "Auto retry"/);
});
