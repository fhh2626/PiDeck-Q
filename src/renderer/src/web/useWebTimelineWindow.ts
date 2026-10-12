/**
 * useWebTimelineWindow — Web 端时间线显示窗口与滚动跟随（2026-12：至少 100 个显示单元）。
 *
 * 职责（单一 owner，不向 WebChatApp 扩散状态）：
 * - 计算可见消息：跟底时 = 最近至少 100 个显示单元；离开底部后冻结在当时的窗口起点，
 *   新到达的轮次只追加在下方，不把正在阅读的内容挤出窗口。
 * - 历史入口：先展开已加载但被窗口隐藏的更早轮次（不发请求），
 *   再向磁盘请求更早页（由调用方 onLoadMore 负责），新页落地后必须真正可见。
 * - 顶部前插/展开的滚动锚点补偿：刷新前记录可见起点身份与偏移，刷新后恢复；
 *   贴顶也同样恢复，阅读位置不换屏（与桌面端同一约定）。
 *
 * 只做展示切片，不修改底层消息、不调用 setMessages。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import {
	WEB_TIMELINE_MIN_DISPLAY_ITEMS,
	WEB_TIMELINE_TURN_EXPAND_STEP,
	countWebTurns,
	selectWebItemWindow,
} from "./webTurnWindow";
import { uiMessageRole } from "./webMessageMetadata";

/** 跟随底部的判定阈值（px）：与此前 WebTimeline 的 160px 行为一致。 */
const BOTTOM_THRESHOLD = 160;

type VisibleAnchor = { id: string; offset: number };
type PendingDiskReveal = {
	sessionId: string | undefined;
	requestHeadId: string | undefined;
	/** 请求成功后应进入 DOM 的新头；未返回结果时保持 undefined。 */
	targetHeadId?: string;
};

export type WebTimelineWindow = {
	/** 供 WebTimeline 挂到滚动容器上的 ref */
	timelineRef: React.RefObject<HTMLDivElement | null>;
	/** 只应渲染的消息（底层数组保持不变） */
	visibleMessages: UIMessage[];
	/** 窗口隐藏的更早轮数（0 = 已加载内容全部可见） */
	hiddenTurnCount: number;
	/** 是否还有已加载但被窗口隐藏的更早内容 */
	hasHiddenMessages: boolean;
	/** 是否还有更早内容可看（缓存内隐藏或磁盘仍可翻） */
	canRevealOlder: boolean;
	/** 是否跟随底部（供「回到底部」按钮显隐） */
	showScrollToBottom: boolean;
	/** 滚动容器 onScroll */
	handleScroll: () => void;
	/** 回到底部：恢复最近 100 个显示单元的窗口并贴底 */
	scrollToBottom: () => void;
	/** 展开更早内容：先展开缓存，缓存耗尽再请求磁盘更早页 */
	revealOlder: () => void;
};

export function useWebTimelineWindow(input: {
	sessionId: string | undefined;
	messages: UIMessage[];
	hasMoreHistory: boolean;
	loadingMore: boolean;
	/** 成功页返回将提交的新消息头；失败/空页返回 null。 */
	onLoadMore: () => Promise<string | null>;
}): WebTimelineWindow {
	const { sessionId, messages, hasMoreHistory, loadingMore, onLoadMore } = input;
	const timelineRef = useRef<HTMLDivElement | null>(null);
	const stickToBottomRef = useRef(true);
	const [following, setFollowing] = useState(true);
	const [showScrollToBottom, setShowScrollToBottom] = useState(false);
	/** 冻结的窗口起点消息 id（undefined = 跟随尾部最近 100 个显示单元）。 */
	const [windowStartId, setWindowStartId] = useState<string | undefined>(undefined);
	/**
	 * 程序化滚动目标位置。用「期望 scrollTop」而不是布尔开关：
	 * 补偿位移若被 clamp 到边界可能根本不产生 scroll 事件，
	 * 布尔标记会把下一次真实的用户滚动误当成程序化滚动而吞掉。
	 */
	const expectedScrollTopRef = useRef<number | null>(null);
	/** 本次刷新前记录的可见锚点，DOM 提交后恢复。 */
	const pendingAnchorRef = useRef<VisibleAnchor | undefined>(undefined);
	/**
	 * 待加载磁盘更早页：记录请求会话与发起时的消息头，成功后再记录返回页的新头。
	 * 只在该新头真正提交到消息 DOM 后前移窗口；失败/空页由结果直接清理，
	 * 不依赖 loadingMore 的复位顺序，也不会把无关头部更新当成旧页落地。
	 */
	const pendingDiskRevealRef = useRef<PendingDiskReveal | null>(null);
	// 结果可能晚于或早于 useChat 消息提交；结果到达后也必须触发一次 DOM 检查。
	const [diskResultEpoch, setDiskResultEpoch] = useState(0);
	/**
	 * 主动历史浏览标记（2026-12 修复）：用户点「显示更早」后进入的浏览周期。
	 * 存在期间，updateScrollState 不得仅因几何距离 <160px 就重新开启跟底
	 * （短时间线内容不足一屏时仍会被判 nearBottom=true），否则加载期间的新消息
	 * 会把正在看历史的用户拉回底部。仅由 scrollToBottom 或会话切换清除。
	 */
	const browsingRef = useRef(false);

	// 会话切换：窗口与跟随状态全部复位（旧会话的锚点/补偿不得影响新会话）
	useEffect(() => {
		stickToBottomRef.current = true;
		expectedScrollTopRef.current = null;
		pendingAnchorRef.current = undefined;
		pendingDiskRevealRef.current = null;
		browsingRef.current = false;
		setWindowStartId(undefined);
		setFollowing(true);
		setShowScrollToBottom(false);
	}, [sessionId]);

	const turnWindow = useMemo(() => {
		const base = selectWebItemWindow(messages, WEB_TIMELINE_MIN_DISPLAY_ITEMS);
		if (!windowStartId || following) return base;
		const startIndex = messages.findIndex((message) => message.id === windowStartId);
		// 起点消息已不存在（历史被改写/重新合并）：退回默认窗口（最近至少 100 个显示单元），避免窗口落空
		if (startIndex < 0) return base;
		const visibleMessages = messages.slice(startIndex);
		const totalTurns = countWebTurns(messages);
		const visibleTurns = countWebTurns(visibleMessages);
		return {
			visibleMessages,
			hiddenTurnCount: Math.max(0, totalTurns - visibleTurns),
			hasHiddenMessages: startIndex > 0,
		};
	}, [following, messages, windowStartId]);

	// 展示集合与首条身份在 DOM 提交后同步：事件处理器（scroll/resize）
	// 读取的必须是已提交的值；也便于 React 并发渲染下丢弃未提交的陈值。
	const visibleMessagesRef = useRef<UIMessage[]>(turnWindow.visibleMessages);
	const visibleHeadIdRef = useRef<string | undefined>(turnWindow.visibleMessages[0]?.id);
	useLayoutEffect(() => {
		visibleMessagesRef.current = turnWindow.visibleMessages;
		visibleHeadIdRef.current = turnWindow.visibleMessages[0]?.id;
	}, [turnWindow.visibleMessages]);

	const captureVisibleAnchor = useCallback((): VisibleAnchor | undefined => {
		const el = timelineRef.current;
		if (!el) return undefined;
		const containerTop = el.getBoundingClientRect().top;
		const nodes = el.querySelectorAll("[data-web-message-id]");
		const last = nodes[nodes.length - 1];
		for (const node of nodes) {
			const offset = node.getBoundingClientRect().top - containerTop;
			if (offset >= 0 || node === last) {
				const id = node.getAttribute("data-web-message-id");
				if (!id) return undefined;
				return { id, offset };
			}
		}
		return undefined;
	}, []);

	const restoreVisibleAnchor = useCallback((anchor: VisibleAnchor) => {
		const el = timelineRef.current;
		if (!el) return;
		// 贴顶也要补偿：scrollTop 留在顶部会让新展开/加载的更早内容直接占住当前屏。
		const nodes = el.querySelectorAll("[data-web-message-id]");
		const containerTop = el.getBoundingClientRect().top;
		for (const node of nodes) {
			if (node.getAttribute("data-web-message-id") !== anchor.id) continue;
			const nextOffset = node.getBoundingClientRect().top - containerTop;
			const delta = nextOffset - anchor.offset;
			if (delta !== 0) {
				expectedScrollTopRef.current = el.scrollTop + delta;
				el.scrollTop += delta;
			}
			return;
		}
		// 锚点消息已不在展示列表中（被窗口裁掉）：保持原位，不猜测补偿量
	}, []);

	// DOM 提交后恢复锚点：窗口扩大或历史前插后，视口内容不应跳动。
	useLayoutEffect(() => {
		const pending = pendingAnchorRef.current;
		pendingAnchorRef.current = undefined;
		if (pending) restoreVisibleAnchor(pending);
		// visibleMessages 引用变化 = 展示集合变化（窗口扩大/前插/追加）
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [turnWindow.visibleMessages]);

	// 磁盘更早页落地：请求结果确认了新头身份后，等待该头真正进入 useChat 消息 DOM。
	// loadingMore=false 既可能表示失败，也可能早于成功页的消息提交，不能单凭它清理请求；
	// 成功结果与消息可任意先后落地，结果 epoch 保证两种顺序都能重新检查。
	// 一旦检测到前插：
	//  1) 从当前已提交 DOM 捕获可见锚点（此时 windowStartId 仍指向旧页首，DOM 已是前插后的内容）；
	//  2) 设置 windowStartId=新页首，触发下一次渲染把新页纳入可见窗口；
	//  3) 下一次 DOM 提交后，锚点恢复 effect 消费该锚点，把阅读位置稳定在新页插入后的原位。
	// 失败/空页/请求被放弃由请求结果直接清理，不移动窗口、不留下锚点；游标由 webHistory/WebChatApp 管理。
	useLayoutEffect(() => {
		const pending = pendingDiskRevealRef.current;
		if (!pending) return;
		// 会话已切换：丢弃 A 会话的待加载与锚点，不得应用到 B 会话
		if (pending.sessionId !== sessionId) {
			pendingDiskRevealRef.current = null;
			pendingAnchorRef.current = undefined;
			return;
		}
		const headId = messages[0]?.id;
		if (!pending.targetHeadId || headId !== pending.targetHeadId ||
			headId === pending.requestHeadId) return;
		// 只认本次成功页的目标头，不能把失败后的无关头部改动当成旧页。
		pendingAnchorRef.current = captureVisibleAnchor();
		pendingDiskRevealRef.current = null;
		// 把窗口起点前移到新页首轮，使新页真正可见（下一次渲染 + 锚点恢复 effect 接力）
		setWindowStartId(headId);
	}, [diskResultEpoch, messages, sessionId, captureVisibleAnchor]);

	const updateScrollState = useCallback(() => {
		const el = timelineRef.current;
		if (!el) return;
		const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
		const nearBottom = distance < BOTTOM_THRESHOLD;
		const expectedScrollTop = expectedScrollTopRef.current;
		expectedScrollTopRef.current = null;
		if (expectedScrollTop !== null && Math.abs(el.scrollTop - expectedScrollTop) <= 1) {
			// 补偿位移产生的滚动事件：只同步按钮显隐，不改变跟随/冻结状态
			setShowScrollToBottom(!nearBottom && visibleMessagesRef.current.length > 0);
			return;
		}
		// 主动历史浏览期间：几何上接近底部也不得重新开启跟底（短时间线内容不足一屏
		// 时 nearBottom 恒为 true），否则加载期间的新消息会把正在看历史的用户拉回底部。
		// 仅由 scrollToBottom / 会话切换清除该标记。
		if (browsingRef.current) {
			setShowScrollToBottom(visibleMessagesRef.current.length > 0);
			return;
		}
		const wasFollowing = stickToBottomRef.current;
		stickToBottomRef.current = nearBottom;
		if (wasFollowing !== nearBottom) {
			if (!nearBottom) {
				// 离开底部：冻结当前窗口起点，后续新增轮次不得把它挤出窗口
				const headId = visibleHeadIdRef.current;
				if (headId) setWindowStartId(headId);
			}
			setFollowing(nearBottom);
		}
		setShowScrollToBottom(!nearBottom && visibleMessagesRef.current.length > 0);
	}, []);

	const scrollToBottom = useCallback(() => {
		const el = timelineRef.current;
		if (!el) return;
		stickToBottomRef.current = true;
		// 回到底部 = 结束主动历史浏览，恢复自动跟底
		browsingRef.current = false;
		// 平滑滚动会连续产生多个 scroll 事件，不声明期望位置：
		// 这些事件按真实距离判定即为「正在靠近底部」，语义一致。
		expectedScrollTopRef.current = null;
		setFollowing(true);
		// 回到底部 = 新的浏览周期：窗口复位到最近 N 轮，不写回底层消息
		setWindowStartId(undefined);
		setShowScrollToBottom(false);
		el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
	}, []);

	/** 从窗口起点再往前退 step 个用户轮次，返回新的起点消息 id（不足则到数组头）。 */
	const stepBackWindowStart = useCallback((): string | undefined => {
		const all = messages;
		const currentStartIndex = all.findIndex(
			(message) => message.id === visibleHeadIdRef.current,
		);
		if (currentStartIndex <= 0) return all[0]?.id;
		let turnsSeen = 0;
		for (let index = currentStartIndex - 1; index >= 0; index -= 1) {
			// 与窗口切片同一角色判定（历史转换把 tool/system 映射成 assistant role，
			// 只看 message.role 会把它们当成用户提问）
			let isUser = false;
			try {
				isUser = uiMessageRole(all[index]) === "user";
			} catch {
				isUser = false;
			}
			if (!isUser) continue;
			turnsSeen += 1;
			if (turnsSeen >= WEB_TIMELINE_TURN_EXPAND_STEP) return all[index].id;
		}
		return all[0]?.id;
	}, [messages]);

	const revealOlder = useCallback(() => {
		if (loadingMore) return;
		const canExpandCached = turnWindow.hiddenTurnCount > 0;
		// 既没有缓存内隐藏轮次、磁盘也没得翻：不登记锚点，避免陈补偿量落到下一次无关刷新上
		if (!canExpandCached && !hasMoreHistory) return;
		// 进入主动历史浏览：后续 loadingMore/几何变化不得重新开启跟底
		browsingRef.current = true;
		// 点「显示更早」= 用户要往上看：必须离开底部跟随，否则窗口会被尾页切片覆盖，
		// 点击看起来“没反应”。回到底部时由 scrollToBottom 重新开启跟随。
		if (stickToBottomRef.current) {
			stickToBottomRef.current = false;
			setFollowing(false);
			// 从当前展示的窗口首条开始往前退，而不是从最新轮次往前退
			const headId = visibleHeadIdRef.current;
			if (headId) setWindowStartId(headId);
		}
		if (canExpandCached) {
			// 已加载但被窗口隐藏：只扩大窗口，不发请求。
			// 点击时即登记锚点（缓存展开是同步的，DOM 提交后直接恢复），
			// 把当前阅读位置固定住。
			pendingAnchorRef.current = captureVisibleAnchor();
			const nextStartId = stepBackWindowStart();
			if (nextStartId) setWindowStartId(nextStartId);
			return;
		}
		// 磁盘路径：不在此处登记点击时锚点。等待期间用户可能继续滚动，
		// 真正要保护的是「页落地时」的阅读位置——由磁盘页 layout effect 在检测到
		// 头部前插的瞬间从已提交 DOM 捕获锚点（见下方 effect）。若在此处登记点击时锚点，
		// 它会被前插提交时的锚点恢复 effect 提前消费，把视口拉回点击位置。
		// 缓存已到边界：请求磁盘更早页。登记发起时的会话与消息头 id，
		// 页落地后由上面的 layout effect 比对头 id 识别前插，并把窗口起点前移到新页首轮。
		const pending: PendingDiskReveal = { sessionId, requestHeadId: messages[0]?.id };
		pendingDiskRevealRef.current = pending;
		void onLoadMore().then((headId) => {
			if (pendingDiskRevealRef.current !== pending) return; // 切换会话或新请求已取代此请求
			if (!headId || headId === pending.requestHeadId) {
				pendingDiskRevealRef.current = null; // 失败/空页/无前插：不留陈旧锚点
				return;
			}
			pending.targetHeadId = headId;
			setDiskResultEpoch((epoch) => epoch + 1);
		}).catch(() => {
			if (pendingDiskRevealRef.current === pending) pendingDiskRevealRef.current = null;
		});
	}, [
		captureVisibleAnchor,
		hasMoreHistory,
		loadingMore,
		onLoadMore,
		stepBackWindowStart,
		turnWindow.hiddenTurnCount,
	]);

	// 新消息/流式增量到达：仅在用户原本接近底部时跟随，避免打断阅读历史。
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			const el = timelineRef.current;
			if (el && stickToBottomRef.current) el.scrollTo({ top: el.scrollHeight });
			updateScrollState();
		});
		return () => cancelAnimationFrame(frame);
		// messages 变化既覆盖新消息，也覆盖同一条 assistant 消息的流式增量。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [messages, input.loadingMore]);

	return {
		timelineRef,
		visibleMessages: turnWindow.visibleMessages,
		hiddenTurnCount: turnWindow.hiddenTurnCount,
		hasHiddenMessages: turnWindow.hasHiddenMessages,
		canRevealOlder: turnWindow.hiddenTurnCount > 0 || hasMoreHistory,
		showScrollToBottom,
		handleScroll: updateScrollState,
		scrollToBottom,
		revealOlder,
	};
}
