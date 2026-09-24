import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { WebSidebar } from "@/web/WebSidebar";
import type { WebState } from "@/web/webTypes";
import { ToolGroupCard } from "@/components/session/ToolCallComponents";
import { WebTimeline } from "@/web/WebTimeline";
import type { ToolGroupItem } from "@/components/app/AppUtils";
import type { UIMessage } from "ai";

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
	const [selectedSessionId, setSelectedSessionId] = useState<string>("sess-idle");
	const [closedSessionId, setClosedSessionId] = useState<string>("");
	const [deletedSessionId, setDeletedSessionId] = useState<string>("");
	const [imagePreviewCalledWith, setImagePreviewCalledWith] = useState<string>("");

	// 状态切换开关
	const [omitActivatingField, setOmitActivatingField] = useState(false);

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
					moreCount={0}
					loadingMore={false}
					streaming={false}
					error={null}
					onLoadMore={() => {}}
				/>
			</section>
		</div>
	);
}

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<InteractionFixtureApp />);
