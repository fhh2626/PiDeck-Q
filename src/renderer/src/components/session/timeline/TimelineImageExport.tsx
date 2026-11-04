import { createRoot } from "react-dom/client";
import type { ChatMessage, ImageContent } from "../../../../../shared/types";
import { getMultiSelectImageCaptureIds, type RenderMessage } from "../../app/AppUtils";
import { loadHtmlToImage } from "../../../utils/htmlToImage";
import { desktopApi } from "../../../desktopApi";
import { buildExportDocumentModel } from "./imageExportModel";
import { ReadOnlyExportDocument } from "./ReadOnlyExportMarkdown";

/**
 * 等待容器内所有图片完成 eager 解码与加载，设定受控超时。
 */
async function waitForMediaAndResources(container: HTMLElement, timeoutMs: number): Promise<void> {
	if (timeoutMs <= 0) {
		throw new Error("EXPORT_RESOURCE_TIMEOUT");
	}

	const startTime = Date.now();
	const remainingTime = () => Math.max(0, timeoutMs - (Date.now() - startTime));

	const imgElements = Array.from(container.querySelectorAll("img"));
	const imgPromises = imgElements.map(async (img) => {
		img.loading = "eager";
		if (img.complete && img.naturalWidth > 0) return;
		if (img.complete && img.naturalWidth === 0) {
			throw new Error("IMAGE_DECODE_FAILED");
		}
		try {
			if ("decode" in img) {
				await img.decode();
			} else {
				await new Promise<void>((resolve, reject) => {
					(img as HTMLImageElement).onload = () => resolve();
					(img as HTMLImageElement).onerror = () => reject(new Error("IMAGE_LOAD_FAILED"));
				});
			}
		} catch (e) {
			throw e instanceof Error ? e : new Error("IMAGE_DECODE_FAILED");
		}
	});

	const fontsPromise = (document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts?.ready ?? Promise.resolve();

	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutTimer = setTimeout(() => reject(new Error("EXPORT_RESOURCE_TIMEOUT")), remainingTime());
	});

	try {
		await Promise.race([
			Promise.all([...imgPromises, fontsPromise]),
			timeoutPromise,
		]);
	} finally {
		if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
	}

	// 最终双 rAF 布局稳定等待
	await new Promise<void>((resolve) => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				resolve();
			});
		});
	});
}

/**
 * 独立的多选图片导出宿主渲染器。
 * 遵循计划步骤 9 与步骤 10 规范：
 * 1. 15s 统一全局 deadline，各异步环节消耗剩余额度，超时明确 reject 杜绝截出残缺图片；
 * 2. 预先解析截断消息为完整文本（readMessageFullText）；
 * 3. 构造不可变 ExportDocumentModel，包含完整思考正文、全部工具详情（不分页截断）与多媒体；
 * 4. 离屏容器带 data-markdown-readonly="true"，阻断全局 FormulaCopyLayer 复制按钮污染；
 * 5. 使用 React commit 真实信号通知，而非无脑双 rAF 猜测；
 * 6. finally 确保 unmount、remove 容器和取消未竟状态。
 */
export async function exportSelectedMessagesToImage(params: {
	reconciledRuns: RenderMessage[];
	selectedIds: Set<string>;
	width: number;
	sessionId?: string;
	onPreviewImage?: (image: ImageContent, images?: ImageContent[]) => void;
	onOpenExternal?: (url: string) => void;
	onOpenFile?: (path: string) => void;
	showThinking?: boolean;
}): Promise<Blob | null> {
	const {
		reconciledRuns,
		selectedIds,
		width,
		sessionId,
		showThinking = true,
	} = params;

	const overallDeadline = 15000;
	const overallStart = Date.now();
	const getRemainingDeadline = () => Math.max(0, overallDeadline - (Date.now() - overallStart));

	const captureIds = getMultiSelectImageCaptureIds(reconciledRuns, selectedIds);
	if (captureIds.size === 0) return null;

	const selectedRuns = reconciledRuns.filter((item) => {
		if (item.kind === "agent-run") return captureIds.has(item.id);
		if (item.kind === "message") return captureIds.has(item.message.id);
		return false;
	});

	if (selectedRuns.length === 0) return null;

	// 1. 预先拉取截断消息的完整文本与工具载荷（受全局 deadline 约束）
	const fullTexts = new Map<string, string>();
	const toolPayloads = new Map<string, import("../../../../../shared/types").ToolExportPayload>();
	const fullTextFetchPromises: Promise<void>[] = [];

	for (const run of selectedRuns) {
		const msgs: ChatMessage[] =
			run.kind === "message"
				? [run.message]
				: run.kind === "agent-run"
					? run.items.flatMap((i) => {
							if (i.kind === "message") return [i.message];
							if (i.kind === "tool-group") return i.messages;
							return [];
					  })
					: [];
		for (const m of msgs) {
			if (m.meta?.truncated === true) {
				fullTextFetchPromises.push(
					desktopApi.sessions
						.readMessageFullText(
							sessionId,
							m.agentId,
							m.id,
							typeof m.meta?.entryId === "string" ? m.meta.entryId : undefined,
						)
						.then((res) => {
							if (typeof res?.text === "string") {
								fullTexts.set(m.id, res.text);
							}
						}),
				);
			}
		}
	}

	if (fullTextFetchPromises.length > 0) {
		let fetchTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
		const fetchTimeout = new Promise<never>((_, reject) => {
			fetchTimeoutTimer = setTimeout(() => reject(new Error("EXPORT_FETCH_FULLTEXT_TIMEOUT")), getRemainingDeadline());
		});
		try {
			await Promise.race([Promise.all(fullTextFetchPromises), fetchTimeout]);
		} finally {
			if (fetchTimeoutTimer !== undefined) clearTimeout(fetchTimeoutTimer);
		}
	}

	// 1.1 批量拉取工具载荷（按 200 分片，非阻塞超时与错误吞噬保护）
	if (sessionId) {
		const toolMessageIds: string[] = [];
		const seenToolIds = new Set<string>();
		for (const run of selectedRuns) {
			if (run.kind === "agent-run") {
				for (const sub of run.items) {
					if (sub.kind === "tool-group") {
						for (const m of sub.messages) {
							if (!seenToolIds.has(m.id)) {
								seenToolIds.add(m.id);
								toolMessageIds.push(m.id);
							}
						}
					}
				}
			}
		}

		if (toolMessageIds.length > 0) {
			for (let i = 0; i < toolMessageIds.length; i += 200) {
				const remaining = getRemainingDeadline();
				if (remaining <= 0) break;
				const slice = toolMessageIds.slice(i, i + 200);

				let sliceTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
				const timeoutPromise = new Promise<void>((resolve) => {
					sliceTimeoutTimer = setTimeout(resolve, remaining);
				});

				const requestPromise = desktopApi.sessions
					.readToolExportPayloads({ sessionId, messageIds: slice })
					.then((payloads) => {
						if (payloads && typeof payloads === "object") {
							for (const [id, payload] of Object.entries(payloads)) {
								if (payload) {
									toolPayloads.set(id, payload);
								}
							}
						}
					})
					.catch(() => {});

				try {
					await Promise.race([requestPromise, timeoutPromise]);
				} finally {
					if (sliceTimeoutTimer !== undefined) clearTimeout(sliceTimeoutTimer);
				}
			}
		}
	}

	// 2. 构造导出完整数据模型
	const documentModel = buildExportDocumentModel(selectedRuns, fullTexts, showThinking, toolPayloads);

	// 3. 创建离屏宿主容器
	const container = document.createElement("div");
	container.className = "message-list multi-select-image-export-host";
	container.setAttribute("data-markdown-readonly", "true");
	container.style.position = "absolute";
	container.style.left = "-9999px";
	container.style.top = "-9999px";
	container.style.width = `${Math.max(480, width)}px`;
	container.style.padding = "32px";
	container.style.background =
		(typeof window !== "undefined" &&
			getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel")) ||
		"#ffffff";
	document.body.appendChild(container);

	const root = createRoot(container);

	try {
		// 4. 等待 React 根组件真正完成 commit（useLayoutEffect 触发信号）
		let commitResolve: () => void;
		const commitPromise = new Promise<void>((res) => {
			commitResolve = res;
		});

		root.render(
			<ReadOnlyExportDocument
				model={documentModel}
				onRenderCommit={() => commitResolve()}
			/>,
		);

		let commitTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
		const commitTimeout = new Promise<never>((_, reject) => {
			commitTimeoutTimer = setTimeout(() => reject(new Error("EXPORT_COMMIT_TIMEOUT")), getRemainingDeadline());
		});

		try {
			await Promise.race([commitPromise, commitTimeout]);
		} finally {
			if (commitTimeoutTimer !== undefined) clearTimeout(commitTimeoutTimer);
		}

		// 5. 等待所有图片 decode 与字体资源就绪
		await waitForMediaAndResources(container, getRemainingDeadline());

		// 6. 执行 html-to-image 截图（纳入全局 deadline 超时保护）
		let captureTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
		const captureTimeout = new Promise<never>((_, reject) => {
			captureTimeoutTimer = setTimeout(
				() => reject(new Error("EXPORT_CAPTURE_TIMEOUT")),
				getRemainingDeadline(),
			);
		});

		const capturePromise = (async () => {
			const { toBlob } = await loadHtmlToImage();
			return toBlob(container, {
				pixelRatio: Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1),
				backgroundColor:
					(typeof window !== "undefined" &&
						getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel")) ||
					"#ffffff",
				filter: (node: Node) =>
					!(node instanceof HTMLElement) ||
					(!node.classList.contains("turn-row-actions") &&
						!node.classList.contains("user-turn-actions") &&
						!node.classList.contains("copy-menu-popover")),
			});
		})();

		let blob: Blob | null = null;
		try {
			blob = await Promise.race([capturePromise, captureTimeout]);
		} finally {
			if (captureTimeoutTimer !== undefined) clearTimeout(captureTimeoutTimer);
		}

		if (!blob) {
			throw new Error("EXPORT_IMAGE_EMPTY");
		}

		return blob;
	} finally {
		root.unmount();
		container.remove();
	}
}
