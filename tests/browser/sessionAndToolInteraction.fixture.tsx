import React, { useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { flushSync } from "react-dom";
import { WebSidebar } from "@/web/WebSidebar";
import type { WebState } from "@/web/webTypes";
import { chatMessagesToUiMessages } from "@/web/webApi";
import { ToolGroupCard } from "@/components/session/ToolCallComponents";
import { WebTimeline } from "@/web/WebTimeline";
import type { ToolGroupItem } from "@/components/app/AppUtils";
import type { UIMessage } from "ai";
import type { ChatMessage } from "@shared/types";

// 1x1 base64 png
const testPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const sampleProject = {
	id: "proj-1",
	name: "Test Project",
	path: "C:/test-project",
};
const sampleSessions = [
	{ id: "sess-idle", projectId: "proj-1", title: "Idle Session", status: "active" },
	{ id: "sess-activating", projectId: "proj-1", title: "Activating Session", status: "active" },
	{ id: "sess-running", projectId: "proj-1", title: "Running Session", status: "active" },
	{ id: "sess-starting", projectId: "proj-1", title: "Starting Session", status: "active" },
];

function InteractionFixtureApp() {
	// 记录 WebSidebar 交互事件，默认选中 sess-idle 触发项目自动展开
	const [selectedSessionId, setSelectedSessionId] = useState<string>("sess-idle");	const [closedSessionId, setClosedSessionId] = useState<string>("");
	const [deletedSessionId, setDeletedSessionId] = useState<string>("");
	const [imagePreviewCalledWith, setImagePreviewCalledWith] = useState<string>("");

	// 状态切换开关
	const [omitActivatingField, setOmitActivatingField] = useState(false);

	// 透明占位场景开关：true 时中间空助手占位获得可见正文，
	// 验证分组重算后必须恢复边界（工具不再同组）。
	const [placeholderHasText, setPlaceholderHasText] = useState(false);

	// ── Web 时间线窗口场景（50 轮统一）────────────────────────────
	// A. 异步磁盘旧页：初始 50 轮（Question 6..55），点击「加载更多」只置 loadingMore=true，
	//    测试控制何时前插 6 个更早轮次（Question 0..5，与初始轮次不重叠），验证锚点补偿。
	const asyncBuildTurns = (count: number, start: number) => {
		const out: ChatMessage[] = [];
		for (let i = 0; i < count; i += 1) {
			const turn = start + i;
			out.push({ id: `aw-u-${turn}`, agentId: "a", role: "user", text: `Question ${turn}`, timestamp: turn * 2 });
			out.push({ id: `aw-a-${turn}`, agentId: "a", role: "assistant", text: `Answer ${turn}`, timestamp: turn * 2 + 1 });
		}
		return out;
	};
	const [asyncMessages, setAsyncMessages] = useState<ChatMessage[]>(() => asyncBuildTurns(50, 6));
	const [asyncLoading, setAsyncLoading] = useState(false);
	const [asyncLoaded, setAsyncLoaded] = useState(false);
	const asyncResolveRef = useRef<((headId: string | null) => void) | null>(null);
	const startAsyncLoad = (): Promise<string | null> => {
		setAsyncLoading(true);
		return new Promise((resolve) => { asyncResolveRef.current = resolve; });
	};
	const prependAsyncOlder = () => {
		setAsyncMessages((prev) => [...asyncBuildTurns(6, 0), ...prev]);
		setAsyncLoaded(true);
	};
	// 分开提交 loadingMore 和消息：浏览器用例分别验证消息先到、加载状态先结束。
	const completeAsyncLoad = () => {
		flushSync(() => setAsyncLoading(false));
		asyncResolveRef.current?.("aw-u-0");
		asyncResolveRef.current = null;
	};
	const completeAsyncBeforeMessages = completeAsyncLoad;
	const failAsyncLoad = () => {
		flushSync(() => setAsyncLoading(false));
		asyncResolveRef.current?.(null);
		asyncResolveRef.current = null;
	};
	const prependUnrelatedHead = () => {
		setAsyncMessages((prev) => [
			{ id: "aw-unrelated", agentId: "a", role: "system", text: "Unrelated earlier message", timestamp: -1 },
			...prev,
		]);
	};
	const appendAsyncTurn = () => {
		setAsyncMessages((prev) => {
			const last = Number(prev[prev.length - 1].id.replace(/[^0-9]+/g, ""));
			const turn = last + 1;
			return [...prev, { id: `aw-u-${turn}`, agentId: "a", role: "user", text: `Question ${turn}`, timestamp: turn * 2 }, { id: `aw-a-${turn}`, agentId: "a", role: "assistant", text: `Answer ${turn}`, timestamp: turn * 2 + 1 }];
		});
	};

	// B. 短时间线主动浏览：初始仅 2 轮（Question 7、8，内容不足一屏），仍有磁盘历史；
	//    点击「加载更多」后前插 6 轮（Question 1..6，不重叠）并复位 loading，验证不会重新跟底。
	const [shortMessages, setShortMessages] = useState<ChatMessage[]>(() => asyncBuildTurns(2, 7));
	const [shortLoading, setShortLoading] = useState(false);
	const [shortLoaded, setShortLoaded] = useState(false);
	const loadShortOlder = async (): Promise<string | null> => {
		setShortLoading(true);
		setShortMessages((prev) => [...asyncBuildTurns(6, 1), ...prev]);
		setShortLoading(false);
		setShortLoaded(true);
		return "aw-u-1";
	};
	const appendShortTurn = () => {
		setShortMessages((prev) => {
			const last = Number(prev[prev.length - 1].id.replace(/[^0-9]+/g, ""));
			const turn = last + 1;
			return [...prev, { id: `sw-u-${turn}`, agentId: "a", role: "user", text: `Question ${turn}`, timestamp: turn * 2 }, { id: `sw-a-${turn}`, agentId: "a", role: "assistant", text: `Answer ${turn}`, timestamp: turn * 2 + 1 }];
		});
	};

	const webState: WebState = {
		projects: [sampleProject],
		sessions: sampleSessions,
		runtimes: [
			{ sessionId: "sess-running", agentId: "agent-run", status: "idle", runtimeGeneration: 1 },
			{ sessionId: "sess-starting", agentId: "agent-start", status: "starting", runtimeGeneration: 1 },
		],
		activatingSessionIds: omitActivatingField ? undefined : ["sess-activating"],
		messagesBySession: {},
	};

	// 构造桌面 ToolGroupCard 数据
	const desktopToolGroup: ToolGroupItem = {
		id: "tool-grp-1",
		kind: "tool-group",
		messages: [
			{
				id: "tool-msg-1",
				agentId: "agent-1",
				role: "tool",
				text: "File content read",
				timestamp: 100,
				meta: { toolName: "read_file" },
			},
			{
				id: "tool-msg-2",
				agentId: "agent-1",
				role: "tool",
				text: "Chart created",
				timestamp: 101,
				meta: { toolName: "generate_chart" },
				images: [
					{ type: "image", mimeType: "image/png", data: testPng },
				],
			},
		],
	};

	const singleToolGroup: ToolGroupItem = {
		id: "tool-single-grp",
		kind: "tool-group",
		messages: [
			{
				id: "single-msg-1",
				agentId: "agent-1",
				role: "tool",
				text: "done",
				timestamp: 102,
				meta: { toolName: "fetch" },
			},
		],
	};

	// 构造 WebTimeline 数据
	const webTimelineMessages: UIMessage[] = [
		{
			id: "m-u1",
			role: "user",
			parts: [{ type: "text", text: "Please inspect" }],
		},
		{
			id: "m-t1",
			role: "assistant",
			parts: [
				{
					type: "dynamic-tool",
					toolName: "file_search",
					toolCallId: "call-1",
					state: "output-available",
					input: { query: "test" },
					output: "found 1 file",
				},
			],
		},
		{
			id: "m-t2",
			role: "assistant",
			parts: [
				{
					type: "dynamic-tool",
					toolName: "read_file",
					toolCallId: "call-2",
					state: "output-available",
					input: { path: "a.txt" },
					output: "content",
				},
			],
		},
		{
			id: "m-a1",
			role: "assistant",
			parts: [{ type: "text", text: "Here is the result." }],
		},
	];

	// 透明占位场景（2026-09）：工具 → 空助手占位 → 工具，经真实转换链
	// （ChatMessage → UIMessage）构造，与线上链路一致。中间占位为空时
	// 两个工具应合并为一个可折叠工具组；占位获得正文后必须拆开。
	const placeholderScenarioChatMessages: ChatMessage[] = useMemo(
		() => [
			{ id: "ph-u1", agentId: "a", role: "user", text: "Check the logs", timestamp: 1 },
			{
				id: "ph-t1",
				agentId: "a",
				role: "tool",
				text: "powershell ok",
				timestamp: 2,
				meta: { toolName: "powershell", toolCallId: "ph-call-1", status: "done", result: "log lines" },
			},
			{
				id: "ph-p1",
				agentId: "a",
				role: "assistant",
				text: placeholderHasText ? "Let me look at the file content" : "",
				timestamp: 3,
			},
			{
				id: "ph-t2",
				agentId: "a",
				role: "tool",
				text: "read ok",
				timestamp: 4,
				meta: { toolName: "read", toolCallId: "ph-call-2", status: "done", result: "file content" },
			},
			{ id: "ph-a1", agentId: "a", role: "assistant", text: "All checks complete.", timestamp: 5 },
		],
		[placeholderHasText],
	);

	const placeholderScenarioMessages: UIMessage[] = useMemo(
		() => chatMessagesToUiMessages(placeholderScenarioChatMessages),
		[placeholderScenarioChatMessages],
	);

	// 长会话窗口场景：60 轮「用户提问 + 回复」，用于验证 Web 端只挂载最近 50 轮，
	// 以及「显示更早对话」按展开步长（10 轮）逐步还原。
	const turnWindowMessages: UIMessage[] = useMemo(() => {
		const messages: ChatMessage[] = [];
		for (let turn = 1; turn <= 60; turn += 1) {
			messages.push({
				id: `tw-u-${turn}`,
				agentId: "a",
				role: "user",
				text: `Question ${turn}`,
				timestamp: turn * 2,
			});
			messages.push({
				id: `tw-a-${turn}`,
				agentId: "a",
				role: "assistant",
				text: `Answer ${turn}`,
				timestamp: turn * 2 + 1,
			});
		}
		return chatMessagesToUiMessages(messages);
	}, []);

	return (
		<div className="p-4 space-y-8">
			<header className="flex gap-4 items-center border-b pb-2">
				<h1 className="text-lg font-bold">Session & Tool Interaction Fixture</h1>
				<button
					id="toggle-omit-activating"
					type="button"
					className="px-2 py-1 text-xs border rounded"
					onClick={() => setOmitActivatingField((prev) => !prev)}
				>
					Toggle Omit Activating
				</button>
			</header>

			{/* 观测面板 */}
			<section className="bg-muted p-2 rounded text-xs space-y-1" id="event-monitor">
				<div>Selected Session: <span id="val-selected-session">{selectedSessionId || "none"}</span></div>
				<div>Closed Session: <span id="val-closed-session">{closedSessionId || "none"}</span></div>
				<div>Deleted Session: <span id="val-deleted-session">{deletedSessionId || "none"}</span></div>
				<div>Previewed Image: <span id="val-preview-image">{imagePreviewCalledWith || "none"}</span></div>
			</section>

			{/* WebSidebar 容器 */}
			<section className="border p-2 rounded w-72">
				<h2 className="text-sm font-semibold mb-2">WebSidebar</h2>
				<WebSidebar
					state={webState}
					activeSessionId={selectedSessionId}
					creatingProjectId=""
					connected={true}
					mobileOpen={false}
					onCloseMobile={() => {}}
					onSelectSession={(id) => setSelectedSessionId(id)}
					onCreateSession={() => {}}
					onCreateProject={async (path) => ({ id: "new-p", name: "New", path })}
					onDeleteProject={async () => {}}
					onCloseSession={async (id) => { setClosedSessionId(id); }}
					onDeleteSession={async (id) => { setDeletedSessionId(id); }}
				/>
			</section>

			{/* 桌面 ToolGroupCard 容器 */}
			<section className="border p-2 rounded w-96 space-y-4" id="desktop-tool-section">
				<h2 className="text-sm font-semibold">Desktop ToolGroupCard</h2>
				<div id="desktop-multi-group">
					<ToolGroupCard
						group={desktopToolGroup}
						onPreviewImage={(img) => setImagePreviewCalledWith(img.mimeType)}
					/>
				</div>
				<div id="desktop-single-group">
					<ToolGroupCard
						group={singleToolGroup}
					/>
				</div>
			</section>

			{/* WebTimeline 容器 */}
			<section className="border p-2 rounded w-96" id="web-timeline-section">
				<h2 className="text-sm font-semibold mb-2">WebTimeline Tool Grouping</h2>
				<WebTimeline
					messages={webTimelineMessages}
					hasActiveSession={true}
					hasMoreHistory={false}
					loadingMore={false}
					streaming={false}
					error={null}
					onLoadMore={async () => null}
				/>
			</section>

			{/* 透明占位场景：工具 → 空助手占位 → 工具（真实转换链构造） */}
			<section className="border p-2 rounded w-96" id="web-timeline-placeholder-section">
				<h2 className="text-sm font-semibold mb-2">WebTimeline Empty-Placeholder Tool Grouping</h2>
				<button
					id="toggle-placeholder-text"
					type="button"
					className="px-2 py-1 text-xs border rounded mb-1"
					onClick={() => setPlaceholderHasText((prev) => !prev)}
				>
					Toggle Placeholder Text
				</button>
				<WebTimeline
					messages={placeholderScenarioMessages}
					hasActiveSession={true}
					hasMoreHistory={false}
					loadingMore={false}
					streaming={false}
					error={null}
					onLoadMore={async () => null}
				/>
			</section>

			{/* 长会话窗口场景：50 轮窗口 + 展开步长 */}
			<section className="border p-2 rounded w-96" id="web-timeline-turn-window-section">
				<h2 className="text-sm font-semibold mb-2">WebTimeline 50-Turn Window</h2>
				<WebTimeline
					messages={turnWindowMessages}
					sessionId="sess-turn-window"
					hasActiveSession={true}
					hasMoreHistory={false}
					loadingMore={false}
					streaming={false}
					error={null}
					onLoadMore={async () => null}
				/>
			</section>

			{/* 异步磁盘旧页场景：加载期间前插 + 锚点补偿（真实可滚动容器） */}
			<section className="border p-2 rounded w-96" id="web-timeline-async-section">
				<h2 className="text-sm font-semibold mb-2">WebTimeline Async Disk Page + Anchor</h2>
				<div className="flex gap-1 mb-1">
					<button id="async-prepend" type="button" className="px-2 py-0.5 text-xs border rounded" onClick={prependAsyncOlder}>Prepend</button>
					<button id="async-complete" type="button" className="px-2 py-0.5 text-xs border rounded" onClick={completeAsyncLoad}>Complete</button>
					<button id="async-complete-before-messages" type="button" className="px-2 py-0.5 text-xs border rounded" onClick={completeAsyncBeforeMessages}>Complete Before Messages</button>
					<button id="async-fail" type="button" className="px-2 py-0.5 text-xs border rounded" onClick={failAsyncLoad}>Fail</button>
					<button id="async-empty" type="button" className="px-2 py-0.5 text-xs border rounded" onClick={failAsyncLoad}>Empty Page</button>
					<button id="async-append" type="button" className="px-2 py-0.5 text-xs border rounded" onClick={appendAsyncTurn}>Append</button>
					<button id="async-unrelated-head" type="button" className="px-2 py-0.5 text-xs border rounded" onClick={prependUnrelatedHead}>Unrelated Head</button>
				</div>
				<div className="h-72 min-h-0">
					<WebTimeline
						messages={chatMessagesToUiMessages(asyncMessages)}
						sessionId="sess-async"
						hasActiveSession={true}
						hasMoreHistory={!asyncLoaded}
						loadingMore={asyncLoading}
						streaming={false}
						error={null}
						onLoadMore={startAsyncLoad}
					/>
				</div>
			</section>

			{/* 短时间线主动浏览场景：内容不足一屏时点「加载更多」后不得重新跟底 */}
			<section className="border p-2 rounded w-96" id="web-timeline-short-section">
				<h2 className="text-sm font-semibold mb-2">WebTimeline Short-Timeline Browsing Lock</h2>
				<button id="short-append" type="button" className="px-2 py-0.5 text-xs border rounded mb-1" onClick={appendShortTurn}>Append Turn</button>
				<WebTimeline
					messages={chatMessagesToUiMessages(shortMessages)}
					sessionId="sess-short"
					hasActiveSession={true}
					hasMoreHistory={!shortLoaded}
					loadingMore={shortLoading}
					streaming={false}
					error={null}
					onLoadMore={loadShortOlder}
				/>
			</section>
		</div>
	);
}

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<InteractionFixtureApp />);
