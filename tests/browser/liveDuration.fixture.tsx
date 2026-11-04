import React, { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LiveDuration } from "@/components/session/LiveDuration";

/**
 * LiveDuration 行为夹具（真实组件，无 mock 逻辑）：
 * - stable：起点固定在挂载时刻 -2s，正常秒表；
 * - refreshing：起点每 150ms 被刷成 now，identity 不变——
 *   复现 powershell / subagent 旧 bug 的时序（起点字段被上游刷新）。
 *
 * 期望：refreshing 的读数不倒退（单调钳制按 identity 生效）；stable 正常增长。
 */
function Fixture() {
	const [stableStart] = useState(() => Date.now() - 2_000);
	const [refreshingStart, setRefreshingStart] = useState(() => Date.now());

	useEffect(() => {
		// 模拟 tool_execution_update 高频刷新 ChatMessage.timestamp 的节奏
		const timer = window.setInterval(() => setRefreshingStart(Date.now()), 150);
		return () => window.clearInterval(timer);
	}, []);

	return (
		<main style={{ fontFamily: "monospace", fontSize: 14, padding: 12 }}>
			<div>
				<span>stable=</span>
				<span data-testid="stable">
					<LiveDuration identity="stable" startedAt={stableStart} isStreaming />
				</span>
			</div>
			<div>
				<span>refreshing=</span>
				<span data-testid="refreshing">
					<LiveDuration identity="refreshing" startedAt={refreshingStart} isStreaming />
				</span>
			</div>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Fixture />
	</StrictMode>,
);
