/**
 * 视觉桥 IPC 域：只做输入校验与装配，业务在 VisionBridgeConfigManager。
 * 通道：vision:get-config / vision:save-config / vision:get-log / vision:clear-log（shared/ipc.ts 定义）。
 */
import { ipcChannels } from "../../shared/ipc";
import type { VisionBridgeConfigManager } from "../settings/visionBridgeConfig";
import type { RpcRouter } from "../transport/RpcRouter";

export function registerVisionIpc(
	router: RpcRouter,
	deps: {
		visionBridge: VisionBridgeConfigManager;
		log: (message: string, ...args: unknown[]) => void;
	},
) {
	const { visionBridge, log } = deps;

	router.handle(ipcChannels.visionGetConfig, () => visionBridge.getState());

	router.handle(ipcChannels.visionSaveConfig, async (input: unknown) => {
		// 渲染层数据不可信：manager 内部逐字段白名单校验
		const result = await visionBridge.saveConfig(input);
		log("vision", "Vision bridge config saved", {
			ok: result.ok,
			// 不记录 apiKey 等敏感字段
			provider: typeof input === "object" && input !== null ? (input as { provider?: unknown }).provider : undefined,
		});
		return result;
	});

	// 运行日志诊断：只读/清空，无入参无需校验
	router.handle(ipcChannels.visionGetLog, () => visionBridge.getLog());

	// 结构化转换事件（会话渲染层展示请求详情）：只读尾部，坏行已在 manager 内跳过
	router.handle(ipcChannels.visionGetEvents, () => visionBridge.getEvents());

	router.handle(ipcChannels.visionClearEvents, async () => {
		const result = await visionBridge.clearEvents();
		log("vision", "Vision events cleared", { ok: result.ok });
		return result;
	});

	router.handle(ipcChannels.visionClearLog, async () => {
		const result = await visionBridge.clearLog();
		log("vision", "Vision bridge log cleared", { ok: result.ok });
		return result;
	});
}
