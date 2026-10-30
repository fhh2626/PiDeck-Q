import { useEffect } from "react";
import { useAtomValue, useStore } from "jotai";
import type { AvailableModel, VisionBridgeConfig } from "../../../shared/types";
import { modelListRevisionAtom } from "../atoms/model-atoms";
import { visionConfigRevisionAtom } from "../atoms/session-atoms";
import {
	visionBridgeCapabilitiesAtom,
	visionBridgeRequestSeqAtom,
	type VisionBridgeCapabilities,
} from "../atoms/vision-atoms";
import { desktopApi } from "../desktopApi";

/** 模型列表读取失败（含运行时没有该 API）时降级为空列表：能力未知，交给轮询判定。 */
async function readModels(): Promise<AvailableModel[]> {
	try {
		return await desktopApi.projects.listModels();
	} catch {
		return [];
	}
}

/** 视觉桥配置读取失败时按「未配置」处理，不显示转换提示。 */
async function readConfig(): Promise<VisionBridgeConfig | null> {
	try {
		const state = await desktopApi.config.visionGetConfig();
		return state?.config ?? null;
	} catch {
		return null;
	}
}

/**
 * 读取视觉桥能力快照：全量模型列表（判断模型是否原生支持图片）+ 当前视觉桥配置。
 *
 * 两个失效信号都会触发重拉：
 * - visionConfigRevisionAtom：设置页保存视觉桥配置；
 * - modelListRevisionAtom：主进程重取模型缓存（保存 models.json/auth.json、切换 pi 运行时）。
 * 多个气泡同时挂载时用 atom 里的版本键占位去重，保证全应用只发一次请求。
 */
export function useVisionBridgeCapabilities(): VisionBridgeCapabilities {
	const capabilities = useAtomValue(visionBridgeCapabilitiesAtom);
	const configRevision = useAtomValue(visionConfigRevisionAtom);
	const modelRevision = useAtomValue(modelListRevisionAtom);
	const store = useStore();
	// 活性保证：readModels/readConfig 自身吞掉异常（只会 resolve），占位版本键一定能被完成结果清掉；
	// 即便 IPC 本体卡住，主进程模型列表也自带 20s 子进程超时，不会永久停在「未就绪」。
	// 两个修订都必须参与：只盯配置会让新增/改动的模型在重启前一直被判为「能力未知」。
	const loadKey = `${configRevision}:${modelRevision}`;

	useEffect(() => {
		// store.get 是同步新读：并发挂载的其它气泡已经登记同一个版本键时直接跳过。
		if (store.get(visionBridgeCapabilitiesAtom).loadKey === loadKey) return;
		const seq = store.get(visionBridgeRequestSeqAtom) + 1;
		store.set(visionBridgeRequestSeqAtom, seq);
		// 先登记版本键占位，避免同一次渲染里多个气泡重复发请求。
		store.set(visionBridgeCapabilitiesAtom, (previous) => ({ ...previous, loadKey }));
		void (async () => {
			// 两个请求互不阻塞：任一失败都降级为「没有该能力」，不阻断会话渲染。
			const [models, config] = await Promise.all([readModels(), readConfig()]);
			// 期间又保存了配置/刷新了模型列表：本次结果已过期，交给新请求写入。
			if (store.get(visionBridgeRequestSeqAtom) !== seq) return;
			store.set(visionBridgeCapabilitiesAtom, { ready: true, models, config, loadKey });
		})();
	}, [loadKey, store]);

	return capabilities;
}
