import React, { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { FileDiff, type FileDiffLine } from "@/components/agents/file-diff";
import { AgentCodeLine, useAgentCodeTokens } from "@/components/agents/agent-code";
import "@/styles.css";

/**
 * FileDiff 长会话性能 fixture：用生产组件 + 生产 Worker 复现「一轮几十个改动文件」。
 *
 * 分两部分，各自对应一条只能在真实浏览器里验证的结论：
 * 1. 文件列表：全部收起时正文（逐行节点）必须不在 DOM 里；展开一个只多一份正文；
 * 2. 高亮探针：大段代码的高亮必须跑在 Worker 上（主线程长时间阻塞 = 失败）。
 *
 * 不接桌面 API、Agent、网络或会话数据。
 */

/** 生成第 index 个文件的 diff 内容：每行内容不同，避免高亮缓存在多次测量间抹平差异。 */
function fileContent(index: number, lines: number) {
	return Array.from(
		{ length: lines },
		(_, line) => `export const value_${index}_${line} = ${index * 1000 + line};`,
	).join("\n");
}

/** 高亮探针用的大段代码，行数由 fixture 参数控制。 */
export function probeCode(lines: number) {
	return Array.from(
		{ length: lines },
		(_, line) =>
			`function probe_${line}(input: number): number { return input * ${line} + Math.max(${line}, input); }`,
	).join("\n");
}

export type FileDiffPerfFixture = {
	/** 设置本轮改动的文件数与每个文件的行数。 */
	setFiles: (files: number, linesPerFile: number) => void;
	/** 展开第 index 个文件（等价于用户点击该行）。 */
	openFile: (index: number) => void;
	/** 收起第 index 个文件。 */
	closeFile: (index: number) => void;
	/** 当前 DOM 元素总数。 */
	domNodes: () => number;
	/** 当前挂载的 diff 正文容器数量。 */
	bodyCount: () => number;
	/** 文件名行数量（列表本身必须始终可见）。 */
	fileRowCount: () => number;
	/** 帧间隔心跳记录到的最大间隔（ms）：主线程被阻塞多久。 */
	maxFrameGapMs: () => number;
	/** 重置帧间隔统计。 */
	resetFrameMetrics: () => void;
	/** 触发一次大段代码高亮（走生产 hook → Worker）；render=false 时只拿结果不渲染节点。 */
	runHighlightProbe: (lines: number, render?: boolean) => void;
	/** 探针是否已经拿到高亮结果。 */
	probeReady: () => boolean;
	/** 卸载整个 fixture。 */
	unmount: () => void;
};

declare global {
	interface Window {
		fileDiffPerfFixture?: FileDiffPerfFixture;
	}
}

const metrics = { maxFrameGapMs: 0 };

// 帧间隔心跳：longtask 观察者在 headless Edge 下不触发（人为阻塞 300ms 也读不到），
// 因此用 rAF 间隔直接量「主线程多久没能回到绘制」——实测可区分同步分词（~350ms）与基线（~8ms）。
let heartbeatRunning = false;
let heartbeatLast = 0;
function heartbeatTick() {
	if (!heartbeatRunning) return;
	const now = performance.now();
	const gap = now - heartbeatLast;
	if (gap > metrics.maxFrameGapMs) metrics.maxFrameGapMs = gap;
	heartbeatLast = now;
	requestAnimationFrame(heartbeatTick);
}

/** 单个文件行：生产 FileDiff（正文只在该文件展开时挂载）。 */
function FileRow(props: {
	index: number;
	lines: FileDiffLine[];
	open: boolean;
	onToggle: (index: number, open: boolean) => void;
}) {
	const { index, lines, open, onToggle } = props;
	return (
		<div data-fixture-file={index}>
			<FileDiff
				file={`src/file-${index}.ts`}
				lines={lines}
				status="complete"
				open={open}
				onOpenChange={(next) => onToggle(index, next)}
				language="typescript"
			/>
		</div>
	);
}

/** 高亮探针：走生产 hook（Worker）。render=false 时只验证结果，不产生逐行节点。 */
function HighlightProbe(props: { lines: number; render: boolean }) {
	const code = useMemo(() => probeCode(props.lines), [props.lines]);
	const tokens = useAgentCodeTokens(code, "typescript");
	const offsets = useMemo(() => {
		let offset = 0;
		return code.split("\n").map((content) => {
			const line = { content, offset };
			offset += content.length + 1;
			return line;
		});
	}, [code]);
	return (
		<div data-testid="probe" data-ready={tokens ? "true" : "false"}>
			{tokens && props.render
				? offsets.map((line, index) => (
						<AgentCodeLine key={line.offset} code={line.content} tokens={tokens[index]} />
					))
				: null}
		</div>
	);
}

function Fixture() {
	const [fileCount, setFileCount] = useState(30);
	const [linesPerFile, setLinesPerFile] = useState(40);
	const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
	const [probeLines, setProbeLines] = useState(0);
	const [probeRender, setProbeRender] = useState(true);

	// 行数据只在文件数/行数变化时重建：模拟「一轮结束后 diff 固定不变」。
	const entries = useMemo(
		() =>
			Array.from({ length: fileCount }, (_, index) => {
				const lines: FileDiffLine[] = fileContent(index, linesPerFile)
					.split("\n")
					.map((content, lineIndex) => ({
						id: `added-${lineIndex}`,
						type: "added" as const,
						content,
					}));
				return { key: `src/file-${index}.ts`, lines };
			}),
		[fileCount, linesPerFile],
	);

	const onToggle = useCallback((index: number, open: boolean) => {
		setOpenKeys((previous) => {
			const next = new Set(previous);
			if (open) next.add(`src/file-${index}.ts`);
			else next.delete(`src/file-${index}.ts`);
			return next;
		});
	}, []);

	useEffect(() => {
		heartbeatRunning = true;
		heartbeatLast = performance.now();
		requestAnimationFrame(heartbeatTick);
		return () => {
			heartbeatRunning = false;
		};
	}, []);

	useEffect(() => {
		window.fileDiffPerfFixture = {
			setFiles: (files, lines) => {
				setFileCount(files);
				setLinesPerFile(lines);
				setOpenKeys(new Set());
			},
			openFile: (index) =>
				setOpenKeys((previous) => new Set(previous).add(`src/file-${index}.ts`)),
			closeFile: (index) =>
				setOpenKeys((previous) => {
					const next = new Set(previous);
					next.delete(`src/file-${index}.ts`);
					return next;
				}),
			domNodes: () => document.getElementsByTagName("*").length,
			bodyCount: () => document.querySelectorAll('[data-slot="file-diff-viewport"]').length,
			fileRowCount: () => document.querySelectorAll("[data-fixture-file]").length,
			maxFrameGapMs: () => metrics.maxFrameGapMs,
			resetFrameMetrics: () => {
				metrics.maxFrameGapMs = 0;
				heartbeatLast = performance.now();
			},
			runHighlightProbe: (lines, render = true) => {
				setProbeRender(render);
				setProbeLines(lines);
			},
			probeReady: () =>
				document.querySelector('[data-testid="probe"]')?.getAttribute("data-ready") === "true",
			unmount: () => root.unmount(),
		};
		return () => {
			delete window.fileDiffPerfFixture;
		};
	}, []);

	return (
		<div>
			{entries.map((entry, index) => (
				<FileRow
					key={entry.key}
					index={index}
					lines={entry.lines}
					open={openKeys.has(entry.key)}
					onToggle={onToggle}
				/>
			))}
			{probeLines > 0 ? <HighlightProbe lines={probeLines} render={probeRender} /> : null}
		</div>
	);
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing root");
const root = createRoot(rootElement);
root.render(
	<StrictMode>
		<Fixture />
	</StrictMode>,
);
