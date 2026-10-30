import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import type { ChatMessage, VisionBridgeEvent } from "../../../shared/types";
import { sessionRecordsAtom, sessionRuntimeByIdAtom } from "../atoms/session-atoms";
import { desktopApi } from "../desktopApi";
import {
	buildModelKey,
	resolveModelImageSupport,
	shouldPollVisionBridge,
	shouldShowVisionConvertingHint,
} from "../utils/modelImageCapability";
import { classifyVisionBridgeMatch, matchVisionBridgeEvent } from "../utils/visionBridgeBlocks";
import { visionImageHashes } from "../utils/visionImageHash";
import { useVisionBridgeCapabilities } from "./useVisionBridgeCapabilities";

/** 发送后短窗口内的轮询节奏：命中即停；全部落空则静默放弃。 */
const POLL_DELAYS_MS = [0, 700, 1800, 3200] as const;
/**
 * 「转换中」提示的延迟：极快的转换（或扩展写下的让路事件）不该先闪一个转圈图标。
 * 超过这个时长仍未拿到结论才显示，避免用户看到假忙碌。
 */
const CONVERTING_HINT_DELAY_MS = 1_200;

export type UserMessageVisionPoll = {
	/** 是否展示「视觉桥转换中」提示：仅在确实在等事件、且迟迟没结果时为 true */
	showConverting: boolean;
	/** 匹配到的转换批次；null = 没有可展示的实时转换结果 */
	match: VisionBridgeEvent | null;
};

/**
 * 用户消息的视觉桥实时卡片数据。
 *
 * 背景：pi 只把转换结果写进会话文件，不推送给实时消息流；实时气泡只有原文 + 图片附件，
 * 所以需要在发送后短窗口内按图片哈希去事件文件里匹配本次转换批次。
 *
 * 关键约束：
 * - 只有扩展真的可能写事件时才轮询（桥已配置、消息新鲜、无落盘标记块）；
 * - 「视觉桥转换中」提示另外判定，且只依据桌面模型列表：列表说模型原生支持图片时不显示转圈。
 *   这份列表与 pi 自己的 ctx.model.input 不是同一份数据，可能不一致，所以它只能决定「显不显示提示」，
 *   不能决定「要不要去找事件」——用它决定不找，会在列表误报「支持图片」时丢掉本该出现的转换卡片。
 */
export function useUserMessageVisionPoll(options: {
	/** 会话身份，用于解析该消息所用模型的图片能力 */
	sessionId?: string;
	message: ChatMessage;
	/** 消息正文里已存在的视觉桥标记块数量（历史消息无需再等事件） */
	inlineBlockCount: number;
}): UserMessageVisionPoll {
	const sessionId = options.sessionId ?? "";
	const { message, inlineBlockCount } = options;

	const capabilities = useVisionBridgeCapabilities();
	// 消息「新鲜度」按挂载时刻评估（而非每次渲染的 Date.now()）：
	// 历史消息挂载时就已过期，而刚发出的消息即使能力快照晚到几秒仍应继续轮询。
	const [mountedAt] = useState(() => Date.now());

	// 只订阅模型标识字符串：运行中 state 对象每帧都会换身份，
	// 直接订阅整个 runtime 会让所有历史用户气泡跟着流式输出重渲染。
	const runtimeModelKey = useAtomValue(
		useMemo(
			() =>
				selectAtom(sessionRuntimeByIdAtom, (map) => {
					const state = map[sessionId]?.state;
					return buildModelKey(state?.provider, state?.modelId);
				}),
			[sessionId],
		),
	);
	const recordModelKey = useAtomValue(
		useMemo(
			() =>
				selectAtom(sessionRecordsAtom, (records) => {
					const model = records[sessionId]?.model;
					return buildModelKey(model?.provider, model?.modelId);
				}),
			[sessionId],
		),
	);

	// 运行中模型优先，其次会话记录里最后一次 model_change；undefined = 列表里查不到（能力未知）。
	const modelSupportsImages = useMemo(
		() => resolveModelImageSupport(capabilities.models, runtimeModelKey || recordModelKey),
		[runtimeModelKey, recordModelKey, capabilities.models],
	);

	const imageCount = message.images?.length ?? 0;
	// 要不要去找事件（与模型能力无关，见 shouldPollVisionBridge 注释）
	const eligible = useMemo(
		() =>
			capabilities.ready &&
			shouldPollVisionBridge({
				hasImages: imageCount > 0,
				hasInlineBlocks: inlineBlockCount > 0,
				visionBridge: capabilities.config,
				sentAt: message.timestamp,
				now: mountedAt,
			}),
		[
			capabilities.ready,
			capabilities.config,
			imageCount,
			inlineBlockCount,
			message.timestamp,
			mountedAt,
		],
	);
	// 要不要显示「转换中」提示：模型原生看图时即使仍轮询，也不得先闪假忙碌
	const hintEligible = shouldShowVisionConvertingHint({ modelSupportsImages });

	// 图片哈希与扩展侧 imageHash（sha256 前 24 位）同源，跨进程可匹配。
	const [imageHashes, setImageHashes] = useState<string[] | null>(null);
	useEffect(() => {
		const images = message.images ?? [];
		if (!eligible || images.length === 0) {
			setImageHashes(null);
			return;
		}
		let cancelled = false;
		void visionImageHashes(images.map((image) => image.data)).then((hashes) => {
			if (!cancelled) setImageHashes(hashes);
		});
		return () => {
			cancelled = true;
		};
	}, [eligible, message.images]);

	const [match, setMatch] = useState<VisionBridgeEvent | null>(null);
	const [polling, setPolling] = useState(false);
	useEffect(() => {
		if (!eligible || !imageHashes || imageHashes.length === 0) {
			setPolling(false);
			return;
		}
		let cancelled = false;
		let timer: number | undefined;
		let attempt = 0;
		const poll = async (): Promise<void> => {
			if (cancelled) return;
			setPolling(true);
			try {
				const info = await desktopApi.config.visionGetEvents();
				if (cancelled) return;
				const matched = matchVisionBridgeEvent(info.events, imageHashes, message.timestamp);
				const kind = classifyVisionBridgeMatch(matched);
				if (kind === "converted" && matched) {
					setMatch(matched);
					setPolling(false);
					return;
				}
				if (kind === "skipped") {
					// 扩展明确让路（模型原生支持图片）：这张图不会变成文字，停止等待且不出卡片。
					setPolling(false);
					return;
				}
			} catch {
				// 拉取失败静默，等下一轮重试
			}
			attempt += 1;
			if (attempt < POLL_DELAYS_MS.length) {
				timer = window.setTimeout(() => void poll(), POLL_DELAYS_MS[attempt]);
			} else {
				setPolling(false);
			}
		};
		void poll();
		return () => {
			cancelled = true;
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [eligible, imageHashes, message.timestamp]);

	// 「转换中」延迟亮相：先等一会儿再显示转圈，快转换/让路事件不会造成闪烁。
	const [showConverting, setShowConverting] = useState(false);
	useEffect(() => {
		if (!hintEligible || !polling || match) {
			setShowConverting(false);
			return;
		}
		const timer = window.setTimeout(() => setShowConverting(true), CONVERTING_HINT_DELAY_MS);
		return () => window.clearTimeout(timer);
	}, [hintEligible, polling, match]);

	// 三重条件：允许提示（模型不原生看图）、确实在等事件、已超过延迟
	return { showConverting: hintEligible && showConverting && !match, match };
}
