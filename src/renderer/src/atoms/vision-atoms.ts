import { atom } from "jotai";
import type { AvailableModel, VisionBridgeConfig } from "../../../shared/types";

/**
 * 视觉桥能力快照状态（纯状态，不在此发起 IPC）。
 *
 * 用途：时间线里的用户气泡据此判断「这张图会不会被视觉桥转成文字」，
 * 只有会转换时才轮询事件文件显示「转换中」。全量模型列表与视觉桥配置是全局数据，
 * 放在 atom 里让所有气泡共享同一份，而不是每行各拉一次 IPC。
 */
export type VisionBridgeCapabilities = {
	/** 模型列表与视觉桥配置都已就绪；未就绪时调用方不应据此抑制或显示转换提示 */
	ready: boolean;
	models: AvailableModel[];
	config: VisionBridgeConfig | null;
	/** 已请求（或已完成）加载对应的版本键（配置修订 + 模型列表修订）；空串 = 从未请求 */
	loadKey: string;
};

const EMPTY_CAPABILITIES: VisionBridgeCapabilities = {
	ready: false,
	models: [],
	config: null,
	loadKey: "",
};

export const visionBridgeCapabilitiesAtom = atom<VisionBridgeCapabilities>(
	EMPTY_CAPABILITIES,
);

/**
 * 请求代次：视觉桥配置在加载途中再次保存时递增，
 * 在途的旧请求结束时据此丢弃自己的结果，避免旧的 config 覆盖新的。
 */
export const visionBridgeRequestSeqAtom = atom(0);
