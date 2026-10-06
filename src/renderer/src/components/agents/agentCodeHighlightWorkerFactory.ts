import {
	type HighlightWorkerPort,
	parseHighlightResponse,
} from "./agentHighlightTypes";

/**
 * 创建页面级高亮 Worker。
 *
 * vite 通过 `new URL(..., import.meta.url)` 静态分析出 Worker 入口并产出独立 chunk；
 * 这里是唯一持有 `import.meta` 的模块，便于其它模块在 Node 单测里加载。
 */
export function createAgentCodeHighlightWorker(): HighlightWorkerPort {
	const worker = new Worker(
		new URL("./agentCodeHighlight.worker.ts", import.meta.url),
		{ type: "module" },
	);
	return {
		postMessage: (message) => worker.postMessage(message),
		terminate: () => worker.terminate(),
		subscribe: (handler) => {
			const listener = (event: MessageEvent<unknown>) => {
				// Worker 边界数据不可信：解析失败的消息直接忽略，不传给上层。
				const response = parseHighlightResponse(event.data);
				if (response) handler(response);
			};
			worker.addEventListener("message", listener);
			return () => worker.removeEventListener("message", listener);
		},
	};
}
