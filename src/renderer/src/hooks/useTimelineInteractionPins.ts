import { useEffect, useRef, useState, useCallback, useMemo, type RefObject } from "react";
import { useAtomValue } from "jotai";
import type { TimelineRowKey } from "../components/session/timeline/timelineRowModel";
import { sessionEditingRowKeysFamily } from "../atoms/timeline-presentation";

export type PinReason = "editing" | "focus" | "selection" | "jump-target" | "animation";
export { sessionEditingRowKeysFamily } from "../atoms/timeline-presentation";

export type InteractionPinsState = {
	pinnedKeys: ReadonlySet<TimelineRowKey>;
	acquirePin: (key: TimelineRowKey, reason: PinReason, ownerToken: string) => void;
	releasePin: (key: TimelineRowKey, reason: PinReason, ownerToken: string) => void;
	pinActiveAnimation: (key: TimelineRowKey, targetElement?: HTMLElement | null) => () => void;
	pinAnimationByMessageId: (
		messageId: string,
		rowKeyByMessageId: ReadonlyMap<string, TimelineRowKey>,
		targetElement?: HTMLElement | null,
	) => () => void;
};

/**
 * 监听焦点、选区、正在编辑以及入场/退场动画，动态计算当前需要被钉住（防止虚拟卸载）的顶层行 keys。
 * 遵循计划步骤 8 规则：
 * 1. editing pin 直接由会话级 sessionEditingRowKeysFamily 权威派生，失焦绝不卸载；
 * 2. 动画开始前目标顶层 row 进入 pin 集合，并在 animationend 或有界超时兜底后安全释放；
 * 3. 各种 pin reason 拥有独立 ownerToken，避免互相覆盖或提前释放。
 */
export function useTimelineInteractionPins(params: {
	viewportRef: RefObject<HTMLElement | null>;
	sessionId?: string;
}): InteractionPinsState {
	const { viewportRef, sessionId } = params;

	// 权威订阅会话级 editing rowKey 集合
	const sessionEditingKeys = useAtomValue(
		sessionEditingRowKeysFamily(sessionId ?? "__local__"),
	);

	// 动态 pins：key -> reason -> Set<ownerToken>
	const pinMapRef = useRef<Map<TimelineRowKey, Map<string, Set<string>>>>(new Map());
	const [dynamicPinnedKeys, setDynamicPinnedKeys] = useState<ReadonlySet<TimelineRowKey>>(new Set());

	const syncPinnedKeys = useCallback(() => {
		const nextSet = new Set<TimelineRowKey>();
		for (const [key, reasonMap] of pinMapRef.current.entries()) {
			let hasAny = false;
			for (const tokens of reasonMap.values()) {
				if (tokens.size > 0) {
					hasAny = true;
					break;
				}
			}
			if (hasAny) {
				nextSet.add(key);
			}
		}

		setDynamicPinnedKeys((prev) => {
			if (prev.size === nextSet.size) {
				let identical = true;
				for (const k of nextSet) {
					if (!prev.has(k)) {
						identical = false;
						break;
					}
				}
				if (identical) return prev;
			}
			return nextSet;
		});
	}, []);

	const acquirePin = useCallback(
		(key: TimelineRowKey, reason: PinReason, ownerToken: string) => {
			let reasonMap = pinMapRef.current.get(key);
			if (!reasonMap) {
				reasonMap = new Map();
				pinMapRef.current.set(key, reasonMap);
			}
			let tokens = reasonMap.get(reason);
			if (!tokens) {
				tokens = new Set();
				reasonMap.set(reason, tokens);
			}
			tokens.add(ownerToken);
			syncPinnedKeys();
		},
		[syncPinnedKeys],
	);

	const releasePin = useCallback(
		(key: TimelineRowKey, reason: PinReason, ownerToken: string) => {
			const reasonMap = pinMapRef.current.get(key);
			if (!reasonMap) return;
			const tokens = reasonMap.get(reason);
			if (tokens) {
				tokens.delete(ownerToken);
				if (tokens.size === 0) {
					reasonMap.delete(reason);
				}
			}
			if (reasonMap.size === 0) {
				pinMapRef.current.delete(key);
			}
			syncPinnedKeys();
		},
		[syncPinnedKeys],
	);

	// 1. 焦点监听：捕获阶段监听 focusin/focusout
	const currentFocusKeyRef = useRef<TimelineRowKey | null>(null);

	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;

		const handleFocusIn = (e: FocusEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) return;
			const rowEl = target.closest?.("[data-timeline-row-key]");
			const key = rowEl?.getAttribute("data-timeline-row-key");
			if (key) {
				if (currentFocusKeyRef.current && currentFocusKeyRef.current !== key) {
					releasePin(currentFocusKeyRef.current, "focus", "dom-focus");
				}
				currentFocusKeyRef.current = key;
				acquirePin(key, "focus", "dom-focus");
			}
		};

		const handleFocusOut = () => {
			queueMicrotask(() => {
				const active = document.activeElement as HTMLElement | null;
				if (!active || !viewport.contains(active)) {
					if (currentFocusKeyRef.current) {
						releasePin(currentFocusKeyRef.current, "focus", "dom-focus");
						currentFocusKeyRef.current = null;
					}
				}
			});
		};

		viewport.addEventListener("focusin", handleFocusIn, { capture: true });
		viewport.addEventListener("focusout", handleFocusOut, { capture: true });

		return () => {
			viewport.removeEventListener("focusin", handleFocusIn, { capture: true });
			viewport.removeEventListener("focusout", handleFocusOut, { capture: true });
			if (currentFocusKeyRef.current) {
				releasePin(currentFocusKeyRef.current, "focus", "dom-focus");
				currentFocusKeyRef.current = null;
			}
		};
	}, [viewportRef, acquirePin, releasePin]);

	// 2. 选区监听：监听 selectionchange，保护与 Range 相交的已挂载行
	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;

		let prevSelectedKeys = new Set<TimelineRowKey>();

		const handleSelectionChange = () => {
			const selection = window.getSelection();
			if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
				if (prevSelectedKeys.size > 0) {
					for (const key of prevSelectedKeys) {
						releasePin(key, "selection", "text-selection");
					}
					prevSelectedKeys.clear();
				}
				return;
			}

			const range = selection.getRangeAt(0);
			// 仅处理与本 viewport 相交的选区
			if (
				!range.intersectsNode(viewport) &&
				!viewport.contains(range.commonAncestorContainer)
			) {
				if (prevSelectedKeys.size > 0) {
					for (const key of prevSelectedKeys) {
						releasePin(key, "selection", "text-selection");
					}
					prevSelectedKeys.clear();
				}
				return;
			}

			const rowEls = viewport.querySelectorAll("[data-timeline-row-key]");
			const nextKeys = new Set<TimelineRowKey>();
			for (let i = 0; i < rowEls.length; i += 1) {
				const el = rowEls[i];
				if (range.intersectsNode(el)) {
					const key = el.getAttribute("data-timeline-row-key");
					if (key) {
						nextKeys.add(key);
					}
				}
			}

			// 差异同步
			for (const oldKey of prevSelectedKeys) {
				if (!nextKeys.has(oldKey)) {
					releasePin(oldKey, "selection", "text-selection");
				}
			}
			for (const newKey of nextKeys) {
				if (!prevSelectedKeys.has(newKey)) {
					acquirePin(newKey, "selection", "text-selection");
				}
			}
			prevSelectedKeys = nextKeys;
		};

		document.addEventListener("selectionchange", handleSelectionChange);
		return () => {
			document.removeEventListener("selectionchange", handleSelectionChange);
			for (const key of prevSelectedKeys) {
				releasePin(key, "selection", "text-selection");
			}
			prevSelectedKeys.clear();
		};
	}, [viewportRef, acquirePin, releasePin]);

	// 会话切换时清理内部动态 pin
	useEffect(() => {
		return () => {
			pinMapRef.current.clear();
			setDynamicPinnedKeys(new Set());
		};
	}, [sessionId]);

	/**
	 * 为带有进入/退出动效的行注册临时 Pin，直到动画完成、取消或达到超时兜底。
	 * 若用户开启 prefers-reduced-motion，则直接不执行 pin。
	 * 返回一个取消清理函数。
	 */
	const pinActiveAnimation = useCallback(
		(key: TimelineRowKey, targetElement?: HTMLElement | null): (() => void) => {
			if (
				typeof window !== "undefined" &&
				typeof window.matchMedia === "function" &&
				window.matchMedia("(prefers-reduced-motion: reduce)").matches
			) {
				return () => {};
			}

			const ownerToken = `anim-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			acquirePin(key, "animation", ownerToken);

			let released = false;
			let timer: ReturnType<typeof setTimeout> | null = null;

			const cleanup = () => {
				if (released) return;
				released = true;
				if (timer) {
					clearTimeout(timer);
					timer = null;
				}
				if (targetElement) {
					targetElement.removeEventListener("animationend", handleDone);
					targetElement.removeEventListener("animationcancel", handleDone);
					targetElement.removeEventListener("transitionend", handleDone);
					targetElement.removeEventListener("transitioncancel", handleDone);
				}
				releasePin(key, "animation", ownerToken);
			};

			const handleDone = () => {
				cleanup();
			};

			if (targetElement) {
				targetElement.addEventListener("animationend", handleDone);
				targetElement.addEventListener("animationcancel", handleDone);
				targetElement.addEventListener("transitionend", handleDone);
				targetElement.addEventListener("transitioncancel", handleDone);
			}

			// 600ms 安全超时兜底，防止 CSS 属性无实际动画或 display:none 导致事件丢失
			timer = setTimeout(cleanup, 600);

			return cleanup;
		},
		[acquirePin, releasePin],
	);

	/**
	 * 辅助方法：将 messageId 映射到顶层 rowKey 后钉住，绝不允许将未知 messageId 直接当作 rowKey
	 */
	const pinAnimationByMessageId = useCallback(
		(
			messageId: string,
			rowKeyByMessageId: ReadonlyMap<string, TimelineRowKey>,
			targetElement?: HTMLElement | null,
		): (() => void) => {
			const resolvedRowKey = rowKeyByMessageId.get(messageId);
			if (!resolvedRowKey) return () => {};
			return pinActiveAnimation(resolvedRowKey, targetElement);
		},
		[pinActiveAnimation],
	);

	// 将会话级 editing keys 与动态 pins 合并
	const pinnedKeys: ReadonlySet<TimelineRowKey> = useMemo(() => {
		if (sessionEditingKeys.size === 0) return dynamicPinnedKeys;
		const merged = new Set<TimelineRowKey>(dynamicPinnedKeys);
		for (const key of sessionEditingKeys) {
			merged.add(key);
		}
		return merged;
	}, [dynamicPinnedKeys, sessionEditingKeys]);

	return {
		pinnedKeys,
		acquirePin,
		releasePin,
		pinActiveAnimation,
		pinAnimationByMessageId,
	};
}
