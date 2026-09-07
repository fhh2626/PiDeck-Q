import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	isWebChatStreaming,
	isWebRuntimeBusy,
	isWebComposerBusy,
	shouldResumeWebStream,
	shouldApplyWebRuntimeSnapshotToChat,
} = loadTsCommonJs("src/renderer/src/web/webRuntimeBusy.ts");

test("useChat ready + runtime running is composer busy", () => {
	assert.equal(isWebChatStreaming("ready"), false);
	assert.equal(isWebRuntimeBusy({ status: "running" }), true);
	assert.equal(isWebComposerBusy({
		chatStatus: "ready",
		runtime: { status: "running" },
	}), true);
});

test("useChat streaming without runtime is composer busy", () => {
	assert.equal(isWebComposerBusy({ chatStatus: "streaming" }), true);
	assert.equal(isWebComposerBusy({ chatStatus: "submitted" }), true);
});

test("lagged streaming flags do not keep idle runtime busy", () => {
	assert.equal(isWebRuntimeBusy({
		status: "idle",
		isStreaming: true,
		isExecutingTool: true,
	}), false);
	assert.equal(isWebComposerBusy({
		chatStatus: "ready",
		runtime: { status: "idle", isStreaming: true },
	}), false);
});

test("runtime starting is composer busy", () => {
	assert.equal(isWebRuntimeBusy({ status: "starting" }), true);
	assert.equal(isWebComposerBusy({
		chatStatus: "ready",
		runtime: { status: "starting" },
	}), true);
});

test("executing a tool keeps composer busy", () => {
	assert.equal(isWebRuntimeBusy({ isExecutingTool: true }), true);
	assert.equal(isWebComposerBusy({
		chatStatus: "ready",
		runtime: { isExecutingTool: true },
	}), true);
});

test("ready chat without runtime is not composer busy", () => {
	assert.equal(isWebComposerBusy({ chatStatus: "ready" }), false);
	assert.equal(isWebComposerBusy({ chatStatus: "ready", runtime: undefined }), false);
});

test("ready + running + isStreaming resumes the web stream", () => {
	assert.equal(shouldResumeWebStream({
		chatStatus: "ready",
		runtime: { status: "running", isStreaming: true },
	}), true);
});

test("ready + running + isExecutingTool resumes the web stream", () => {
	assert.equal(shouldResumeWebStream({
		chatStatus: "ready",
		runtime: { status: "running", isStreaming: false, isExecutingTool: true },
	}), true);
});

test("stale running without local generation flags does not resume", () => {
	assert.equal(shouldResumeWebStream({
		chatStatus: "ready",
		runtime: { status: "running" },
	}), false);
});

test("starting runtime does not resume even while streaming flags are set", () => {
	assert.equal(shouldResumeWebStream({
		chatStatus: "ready",
		runtime: { status: "starting", isStreaming: true },
	}), false);
});

test("active useChat streaming does not silently resume", () => {
	assert.equal(shouldResumeWebStream({
		chatStatus: "streaming",
		runtime: { status: "running", isStreaming: true },
	}), false);
});

test("chat error does not take the silent resume path", () => {
	assert.equal(shouldResumeWebStream({
		chatStatus: "ready",
		hasChatError: true,
		runtime: { status: "running", isStreaming: true },
	}), false);
});

test("idle runtime with lagged streaming flags does not resume", () => {
	assert.equal(shouldResumeWebStream({
		chatStatus: "ready",
		runtime: { status: "idle", isStreaming: true },
	}), false);
});

test("WebComposer stop button follows busy not chat streaming alone", () => {
	const composer = readFileSync("src/renderer/src/web/WebComposer.tsx", "utf8");
	assert.match(composer, /busy: boolean/);
	assert.match(composer, /props\.busy \? \(/);
	assert.doesNotMatch(composer, /props\.streaming \? \(/);
});

test("WebChatApp wires composerBusy into composer and timeline chrome", () => {
	const app = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
	assert.match(app, /isWebChatStreaming/);
	assert.match(app, /isWebComposerBusy/);
	assert.match(app, /const chatStreaming = isWebChatStreaming\(status\)/);
	assert.match(app, /const composerBusy = isWebComposerBusy\(\{/);
	assert.match(app, /streaming=\{composerBusy\}/);
	assert.match(app, /busy=\{composerBusy\}/);
	assert.match(app, /if \(composerBusy\) return;/);
	assert.match(app, /streamingRef\.current = chatStreaming/);
	assert.match(app, /if \(!activeSessionId \|\| chatStreaming\) return;/);
	assert.match(app, /if \(!activeSessionId \|\| !chatStreaming\) return;/);
	assert.match(app, /if \(chatStreaming\) return; \/\/ 新实例就绪/);

	const silentStart = app.indexOf("useChat 已 ready 但 runtime 仍在跑");
	const silentEnd = app.indexOf("// 流式期间同步缓存", silentStart);
	assert.ok(silentStart >= 0 && silentEnd > silentStart);
	const silent = app.slice(silentStart, silentEnd);
	assert.match(silent, /shouldResumeWebStream/);
	assert.match(silent, /resumeStream\(\)/);
	assert.match(silent, /\.then\(/);
	assert.match(silent, /streamingRef\.current/);
	assert.match(silent, /\.catch\(/);
	assert.match(silent, /recoveringStreamSessionRef\.current = null/);
	assert.doesNotMatch(silent, /if \(!composerBusy\) return/);
	assert.doesNotMatch(silent, /status !== "running" && !activeRuntime\?\.isStreaming/);
});

test("ready chat does not apply a runtime snapshot while the agent is running", () => {
	assert.equal(shouldApplyWebRuntimeSnapshotToChat({
		chatStreaming: false,
		runtime: { status: "running" },
	}), false);
});

test("ready chat applies a runtime snapshot once the agent is idle", () => {
	assert.equal(shouldApplyWebRuntimeSnapshotToChat({
		chatStreaming: false,
		runtime: { status: "idle" },
	}), true);
});

test("streaming chat does not apply a runtime snapshot even when idle", () => {
	assert.equal(shouldApplyWebRuntimeSnapshotToChat({
		chatStreaming: true,
		runtime: { status: "idle" },
	}), false);
});

test("ready chat does not apply a snapshot while a tool is executing", () => {
	assert.equal(shouldApplyWebRuntimeSnapshotToChat({
		chatStreaming: false,
		runtime: { isExecutingTool: true },
	}), false);
});

test("ready chat applies a snapshot when no runtime is listed", () => {
	assert.equal(shouldApplyWebRuntimeSnapshotToChat({
		chatStreaming: false,
	}), true);
});

test("WebChatApp only setMessages runtime snapshots when applySnapshot is true", () => {
	const app = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
	const syncStart = app.indexOf("将主进程运行时尾部快照");
	const syncEnd = app.indexOf("切换会话：优先从缓存恢复", syncStart);
	assert.ok(syncStart >= 0 && syncEnd > syncStart);
	const sync = app.slice(syncStart, syncEnd);
	assert.match(sync, /shouldApplyWebRuntimeSnapshotToChat/);
	assert.match(sync, /if \(applySnapshot && activeSessionIdRef\.current === sessionId && merged !== current\)/);
	assert.doesNotMatch(sync, /const idle = !streamingRef\.current/);
});
