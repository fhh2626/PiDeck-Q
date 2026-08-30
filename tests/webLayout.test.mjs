import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const webCss = readFileSync("src/renderer/src/web/web.css", "utf8");
const webSidebar = readFileSync("src/renderer/src/web/WebSidebar.tsx", "utf8");
const webHeader = readFileSync("src/renderer/src/web/WebHeader.tsx", "utf8");
const webChatApp = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
const webComposer = readFileSync("src/renderer/src/web/WebComposer.tsx", "utf8");
const webTimeline = readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8");
const webHtml = readFileSync("src/renderer/web.html", "utf8");

test("Web shell keeps sidebar and chat pane in a horizontal split", () => {
	assert.match(
		webCss,
		/\.app\.wechat-shell\s*\{[\s\S]*?flex-direction:\s*row;/,
		"the desktop shell defaults to a vertical layout, so Web must explicitly restore the horizontal split",
	);
	assert.match(
		webCss,
		/\.app\.wechat-shell\s*>\s*\.chat-list-pane\s*\{[\s\S]*?flex:\s*0\s+0\s+280px;[\s\S]*?width:\s*280px;/,
		"the Web sidebar needs a stable width or it consumes the chat pane",
	);
	assert.match(
		webCss,
		/\.app\.wechat-shell\s*>\s*\.chat-pane\s*\{[\s\S]*?flex:\s*1\s+1\s+0;/,
		"the chat pane must own the remaining horizontal space",
	);
});

test("Web project rows can collapse after the active session is revealed", () => {
	assert.match(webSidebar, /useEffect\(\(\) => \{/);
	assert.doesNotMatch(
		webSidebar,
		/expandedProjects\.has\(project\.id\) \|\| project\.id === activeSessionProjectId/,
		"the active project must not be forced open on every render",
	);
	assert.match(webSidebar, /const expanded = searching \|\| expandedProjects\.has\(project\.id\)/);
});

test("Web model picker supports search and mobile header wrapping", () => {
	assert.match(webHeader, /<CommandInput placeholder=\{t\("web\.modelSearch"\)\}/);
	assert.match(webHeader, /CommandEmpty>\{t\("web\.modelEmpty"\)\}/);
	assert.match(webHeader, /chat-header flex min-w-0 flex-wrap/);
	assert.match(webHeader, /chat-header-runtime/);
	assert.match(webHeader, /max-w-52 shrink/);
});

test("Mobile Web header wraps context checks above the model picker", () => {
	const checks = readFileSync("src/renderer/src/web/WebContextChecks.tsx", "utf8");
	assert.match(webCss, /\.chat-header-actions[\s\S]*flex-wrap:\s*wrap;/);
	assert.doesNotMatch(
		webCss,
		/@media\s*\(max-width:\s*900px\)[\s\S]*\.chat-header-actions[\s\S]*flex-wrap:\s*nowrap;/,
		"phones must not force the header controls onto one squeezed row",
	);
	assert.match(webCss, /chat-context-checks,[\s\S]*flex:\s*1\s+1\s+100%;/);
	assert.match(checks, /chat-context-checks/);
	assert.match(checks, /whitespace-nowrap/);
	assert.match(webHeader, /chat-header-runtime/);
	assert.match(webHeader, /max-w-52 shrink/);
	assert.match(webCss, /overflow-x:\s*auto;/);
});

test("Web header mounts context checkboxes before the model picker", () => {
	const checksIndex = webHeader.indexOf("<WebContextChecks");
	const pickerIndex = webHeader.indexOf("<ModelPicker");
	assert.ok(checksIndex >= 0, "WebHeader must mount WebContextChecks");
	assert.ok(pickerIndex > checksIndex, "context checks must sit left of the model picker");
	const checks = readFileSync("src/renderer/src/web/WebContextChecks.tsx", "utf8");
	assert.match(checks, /applyLocalSwitch/);
	assert.match(checks, /WebKeepSpinBox/);
	assert.match(checks, /\/context-keep/);
	assert.match(checks, /pendingRef/);
});

test("Mobile Web keeps chat full-screen and opens the project tree as a drawer", () => {
	assert.match(webChatApp, /mobileSidebarOpen/);
	assert.match(webChatApp, /onOpenSidebar/);
	assert.match(webSidebar, /mobile-sidebar-backdrop/);
	assert.match(webSidebar, /mobile-open/);
	assert.match(webSidebar, /onDeleteProject/);
});

test("Web starts with no selected session and exposes a scroll-to-bottom action", () => {
	assert.doesNotMatch(webChatApp, /setActiveSessionId\(next\.sessions\[0\]\?\.id \?\? ""\)/);
	assert.match(webChatApp, /setActiveSessionId\(""\)/);
	assert.match(webTimeline, /scroll-to-bottom|ScrollDown|scrollToBottom/);
});

test("Web history load control stays at the top and can recover from a missing cursor", () => {
	assert.match(webChatApp, /hasMoreWebHistory/);
	assert.match(webChatApp, /canRequestWebHistoryPage/);
	assert.match(webChatApp, /catalogMessageCount: activeSession\?\.messageCount/);
	assert.match(webChatApp, /status: "ready"/);
	assert.match(webChatApp, /status: "error"/);
	assert.match(webChatApp, /不要把会话标成 loaded/);
	const loadButton = webTimeline.indexOf('t("timeline.loadMoreHistory"');
	const messageMap = webTimeline.indexOf("messages.map((message)");
	assert.ok(loadButton >= 0, "WebTimeline must render a load-more control");
	assert.ok(messageMap > loadButton, "load more must sit above the message list, not after it");
});

test("Web history remains interactive and cached while an answer streams", () => {
	assert.doesNotMatch(
		webChatApp,
		/if \(!activeSessionId \|\| streaming \|\| loadingMore\) return/,
		"streaming must not silently discard a load-more click",
	);
	assert.doesNotMatch(
		webChatApp,
		/Boolean\(activeSessionId\) && !streaming && hasMoreWebHistory/,
		"the history control must stay visible while the model is answering",
	);
	assert.match(
		webChatApp,
		/messagesBySessionRef\.current\[activeSessionId\] = mergeAuthoritativeUiMessages\(/,
		"streaming updates must merge into prepended history instead of replacing it with the runtime tail",
	);
	assert.match(
		webTimeline,
		/onClick=\{\(\) => \{\s*stickToBottomRef\.current = false;[\s\S]*?onLoadMore\(\);\s*\}\}/,
		"loading older messages must suspend bottom-follow so the prepended page stays visible",
	);
});

test("Web stream-error recovery preserves pages that were already loaded", () => {
	assert.doesNotMatch(
		webChatApp,
		/messagesBySessionRef\.current\[sessionId\] = authoritative;/,
		"a tail-page recovery response must not replace the complete per-session cache",
	);
	assert.doesNotMatch(
		webChatApp,
		/setMessages\(authoritative\)/,
		"error recovery must render the merged cache rather than only the recovered tail page",
	);
});

test("Web stream recovery refreshes a running session without reposting the prompt", () => {
	assert.match(webChatApp, /prepareReconnectToStreamRequest:\s*\(\{ id \}\) => \(\{/);
	assert.match(webChatApp, /api: `\/api\/sessions\/\$\{encodeURIComponent\(id\)\}\/stream`/);
	const recoveryStart = webChatApp.indexOf("// SSE 异常先以权威快照建立新基线");
	const recoveryEnd = webChatApp.indexOf("// 轮询拿到的运行时快照", recoveryStart);
	assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
	const recovery = webChatApp.slice(recoveryStart, recoveryEnd);
	const stateFetch = recovery.indexOf("await fetchState()");
	const pageFetch = recovery.indexOf("await fetchMessagePage(sessionId)");
	const runtimeBaseline = recovery.indexOf("nextState.messagesBySession[sessionId]");
	const resume = recovery.indexOf("await resumeStream()");
	assert.ok(stateFetch >= 0 && pageFetch > stateFetch && runtimeBaseline > pageFetch && resume > runtimeBaseline);
	assert.match(recovery, /runtime\.sessionId === sessionId && runtime\.status === "running"/);
	assert.match(recovery, /mergeAuthoritativeUiMessages\(history, runtimeSnapshot\)/);
	assert.match(recovery, /setMessages\(merged\)/);
	assert.doesNotMatch(recovery, /sendMessage\(/);
	assert.doesNotMatch(recovery, /fetch\("\/api\/chat"/);
});

test("Web tool cards stay compact and keep a visible settled status", () => {
	assert.match(webTimeline, /tool-card inline-flex w-fit max-w-full/);
	assert.match(webTimeline, /t\("tool\.statusDone"\)/);
	assert.match(webTimeline, /formatToolPreview/);
});

test("Web timeline does not double-space tool and thinking steps", () => {
	assert.match(webTimeline, /message-list flex flex-col gap-2 p-4/);
	assert.match(webTimeline, /<div key=\{message\.id\} className="mt-0">/);
	assert.doesNotMatch(webTimeline, /user-turn group\/user mb-4/);
	assert.match(webTimeline, /<TimelineMarker kind="thinking" tone="neutral" contentClassName="pb-0">/);
	assert.match(webTimeline, /<TimelineMarker[\s\S]*?kind="tool"[\s\S]*?contentClassName="pb-0"/);
	assert.match(webTimeline, /flex min-h-6 max-w-full items-center px-2 py-0\.5/);
});

test("Project actions are sibling buttons instead of nested controls", () => {
	assert.match(webSidebar, /project-row-actions[\s\S]*?<Button/);
	assert.doesNotMatch(webSidebar, /project-row-actions[\s\S]*?<span[\s\S]*?role="button"/);
});

test("Web shell tracks the visual viewport so mobile chrome cannot crop the header or composer", () => {
	assert.match(webChatApp, /visualViewport/);
	assert.match(webChatApp, /--web-viewport-height/);
	assert.match(webChatApp, /--web-viewport-width/);
	assert.match(webChatApp, /--web-viewport-offset-left/);
	assert.match(webChatApp, /--web-viewport-offset-top/);
	assert.match(webChatApp, /offsetLeft/);
	assert.match(webChatApp, /offsetTop/);
	assert.match(webCss, /position:\s*fixed/);
	assert.match(webCss, /--web-viewport-width/);
	assert.match(webCss, /--web-viewport-offset-left/);
	assert.match(webCss, /--web-viewport-offset-top/);
	assert.match(webCss, /height:\s*100dvh/);
	assert.match(webCss, /--web-viewport-height/);
	assert.match(webCss, /safe-area-inset-top/);
	assert.match(webCss, /safe-area-inset-bottom/);
	assert.match(webCss, /@media\s*\(max-width:\s*900px\)/);
	assert.match(webCss, /\.chat-list-pane[\s\S]*height:\s*var\(--web-viewport-height/);
	assert.match(webCss, /\.mobile-sidebar-backdrop[\s\S]*height:\s*var\(--web-viewport-height/);
	assert.match(webComposer, /composer[\s\S]*shrink-0/);
	assert.match(webCss, /\.app\.wechat-shell\s*>\s*\.chat-pane\s*>\s*\.composer[\s\S]*margin-bottom:\s*0/);
	assert.match(webHtml, /viewport-fit=cover/);
});

test("Web entry wraps the app in TooltipProvider for context-check hints", () => {
	const webMain = readFileSync("src/renderer/src/web-main.tsx", "utf8");
	assert.match(webMain, /TooltipProvider/);
	assert.match(webMain, /<WebChatApp/);
});
test("Web chat stream errors do not flip the connection badge", () => {
	assert.match(webChatApp, /markWebStateFailure/);
	assert.match(webChatApp, /setCommandError\(t\("web\.streamFailed"\)\)/);
	assert.doesNotMatch(
		webChatApp,
		/setCommandError\(t\("web\.streamFailed"\)\);\s*setConnected\(false\)/,
	);
});
