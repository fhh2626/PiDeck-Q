import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { SessionRuntimeTarget } from "../../../shared/types";

/**
 * 时间线展示状态（Presentation State）。
 *
 * 保证在虚拟列表卸载、重新挂载行时，用户的展开/折叠意图、工具分页、
 * 编辑草稿以及当前 pin（钉住不卸载）原因不丢失。
 */

export type ToolGroupViewState = {
	expanded: boolean;
	pageIndex: number;
	anchorMessageId?: string;
};

export type RunExecutionPresentation = {
	stepsVisible: boolean;
	userOverride: boolean;
	wasRunning: boolean;
	lastCollapseTick: number;
	initialized: boolean;
};

export type EditPresentation =
	| { status: "idle" }
	| {
			status: "editing" | "submitting";
			editId: string;
			messageId: string;
			text: string;
			runtimeTarget: SessionRuntimeTarget;
	  };

export type PinReason = "editing" | "focus" | "selection" | "jump-target";

// 序列化稳定 Key helper
function makeKey(sessionId: string, rowKey: string, kind: string, entityId = ""): string {
	return JSON.stringify([sessionId, rowKey, kind, entityId]);
}

/** 1. Run 过程执行开合与用户 override 状态 */
export const runExecutionPresentationFamily = atomFamily(
	(_key: string) =>
		atom<RunExecutionPresentation>({
			stepsVisible: false,
			userOverride: false,
			wasRunning: false,
			lastCollapseTick: 0,
			initialized: false,
		}),
);

export function getRunExecutionAtom(sessionId: string, rowKey: string) {
	const key = makeKey(sessionId, rowKey, "run-exec");
	trackPresentationKey(sessionId, runExecutionPresentationFamily, key);
	return runExecutionPresentationFamily(key);
}

/** 2. 工具组展示状态（开合/页码） */
export const toolGroupPresentationFamily = atomFamily(
	(_key: string) =>
		atom<ToolGroupViewState>({
			expanded: false,
			pageIndex: 0,
			anchorMessageId: undefined,
		}),
);

export function getToolGroupAtom(sessionId: string, rowKey: string, toolGroupId: string) {
	const key = makeKey(sessionId, rowKey, "tool-group", toolGroupId);
	trackPresentationKey(sessionId, toolGroupPresentationFamily, key);
	return toolGroupPresentationFamily(key);
}

/** 3. 工具单个卡片展开状态 */
export const toolCardExpandedFamily = atomFamily(
	(_key: string) => atom<boolean>(false),
);

export function getToolCardExpandedAtom(sessionId: string, rowKey: string, messageId: string) {
	const key = makeKey(sessionId, rowKey, "tool-card", messageId);
	trackPresentationKey(sessionId, toolCardExpandedFamily, key);
	return toolCardExpandedFamily(key);
}

/** 4. 思考块展示状态（展开及已处理结束标记） */
export const thinkingPresentationFamily = atomFamily(
	(_key: string) =>
		atom<{ expanded: boolean; hasHandledEnd: boolean }>({
			expanded: false,
			hasHandledEnd: false,
		}),
);

export function getThinkingPresentationAtom(sessionId: string, rowKey: string, thinkingGroupId: string) {
	const key = makeKey(sessionId, rowKey, "thinking", thinkingGroupId);
	trackPresentationKey(sessionId, thinkingPresentationFamily, key);
	return thinkingPresentationFamily(key);
}

/** 5. 压缩卡片（Compaction）展开状态 */
export const compactionExpandedFamily = atomFamily(
	(_key: string) => atom<boolean>(false),
);

export function getCompactionExpandedAtom(sessionId: string, rowKey: string, compactionId: string) {
	const key = makeKey(sessionId, rowKey, "compaction", compactionId);
	trackPresentationKey(sessionId, compactionExpandedFamily, key);
	return compactionExpandedFamily(key);
}

/** 6. 用户气泡展示状态（长文展开 / vision 展开） */
export const userBubblePresentationFamily = atomFamily(
	(_key: string) =>
		atom<{ messageExpanded: boolean; visionDetailOpen: boolean }>({
			messageExpanded: false,
			visionDetailOpen: false,
		}),
);

export function getUserBubblePresentationAtom(sessionId: string, rowKey: string) {
	const key = makeKey(sessionId, rowKey, "user-bubble");
	trackPresentationKey(sessionId, userBubblePresentationFamily, key);
	return userBubblePresentationFamily(key);
}

/** 7. 消息草稿编辑状态（行内编辑器，可序列化判别联合） */
export const editPresentationFamily = atomFamily(
	(_key: string) =>
		atom<EditPresentation>({
			status: "idle",
		}),
);

export function getEditPresentationAtom(sessionId: string, rowKey: string) {
	const key = makeKey(sessionId, rowKey, "edit");
	trackPresentationKey(sessionId, editPresentationFamily, key);
	return editPresentationFamily(key);
}

/** 会话级当前处于 editing 状态的 rowKey 索引集合 */
export const sessionEditingRowKeysFamily = atomFamily(
	(_sessionId: string) => atom<Set<string>>(new Set<string>()),
);

/** 8. 顶层行 Pin 保护集合（rowKey -> Set<ownerToken> per reason） */
export const rowPinReasonsFamily = atomFamily(
	(_key: string) => atom<Record<PinReason, Set<string>>>(() => ({
		editing: new Set<string>(),
		focus: new Set<string>(),
		selection: new Set<string>(),
		"jump-target": new Set<string>(),
	})),
);

export function getRowPinReasonsAtom(sessionId: string, rowKey: string) {
	const key = makeKey(sessionId, rowKey, "pins");
	trackPresentationKey(sessionId, rowPinReasonsFamily, key);
	return rowPinReasonsFamily(key);
}

export type MediaPresentation = {
	source: string;
	status: "idle" | "loaded" | "error";
};

/** 9. 媒体展示状态（图片已加载/错误状态跨虚拟卸载保存） */
export const mediaPresentationFamily = atomFamily(
	(_key: string) =>
		atom<MediaPresentation>({
			source: "",
			status: "idle",
		}),
);

export function getMediaPresentationAtom(
	sessionId: string,
	rowKey: string,
	messageId: string,
	imageIndex: number,
) {
	const key = makeKey(sessionId, rowKey, "media", `${messageId}:${imageIndex}`);
	trackPresentationKey(sessionId, mediaPresentationFamily, key);
	return mediaPresentationFamily(key);
}

/**
 * 记录某会话下创建过的所有 presentation 键，供会话关闭/LRU 时清理。
 * 遵循计划规范：session -> family -> Set<string>
 */
interface FamilyRemover {
	remove: (key: string) => void;
}

const sessionPresentationIndex = new Map<string, Map<FamilyRemover, Set<string>>>();

export function trackPresentationKey(
	sessionId: string,
	family: FamilyRemover,
	key: string,
) {
	let famMap = sessionPresentationIndex.get(sessionId);
	if (!famMap) {
		famMap = new Map();
		sessionPresentationIndex.set(sessionId, famMap);
	}
	let set = famMap.get(family);
	if (!set) {
		set = new Set();
		famMap.set(family, set);
	}
	set.add(key);
}

/**
 * 清除指定会话的所有时间线展示状态。
 */
export function removeSessionPresentationState(sessionId: string): void {
	const famMap = sessionPresentationIndex.get(sessionId);
	if (famMap) {
		for (const [family, keySet] of famMap.entries()) {
			for (const key of keySet) {
				family.remove(key);
			}
		}
		sessionPresentationIndex.delete(sessionId);
	}
	sessionEditingRowKeysFamily.remove(sessionId);
}

// 初始化时向全局注册清理函数
try {
	// 动态检测全局 registry（避免不同模块格式/ESM/CJS 下硬 import session-atoms 导致路径解析失败）
	const globalScope = typeof globalThis !== "undefined" ? (globalThis as Record<string, unknown>) : {};
	globalScope.__piTimelinePresentationCleanup = removeSessionPresentationState;
} catch {
	// ignore
}
