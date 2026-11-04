import React, { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ToolCard } from "@/components/session/ToolCallComponents";
import type { ChatMessage } from "@shared/types";

/**
 * 真实 ToolCard + 真实数据形态夹具：
 * - meta.startedAt 固定为挂载时刻 -3s（主进程 tool_execution_start 写入后不再变）；
 * - message.timestamp 每 150ms 刷新为 now（复现 AgentManager.upsertToolMessage 在
 *   每次 tool_execution_update 重置 timestamp 的行为）。
 *
 * 期望：卡片时长 ≈ 3s 并持续增长。若回退成用 timestamp 计价，会显示 0~150ms。
 */
function Fixture() {
	const [startedAt] = useState(() => Date.now() - 3_000);
	const [timestamp, setTimestamp] = useState(() => Date.now());

	useEffect(() => {
		const timer = window.setInterval(() => setTimestamp(Date.now()), 150);
		return () => window.clearInterval(timer);
	}, []);

	const message: ChatMessage = {
		id: "tool-msg-ps-1",
		agentId: "agent-1",
		role: "tool",
		text: "▶ powershell",
		timestamp,
		meta: {
			status: "running",
			toolName: "powershell",
			toolCallId: "ps-1",
			startedAt,
			args: JSON.stringify({ command: "Get-ChildItem -Recurse" }),
			detailText: "partial output",
		},
	};

	return (
		<main style={{ width: 720, padding: 12 }}>
			<ToolCard message={message} sessionId="sess-1" />
		</main>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Fixture />
	</StrictMode>,
);
