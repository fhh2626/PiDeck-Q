import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import type { VisionBridgeConfig } from "../../../shared/types";
import { visionConfigRevisionAtom } from "../atoms/session-atoms";
import { desktopApi } from "../desktopApi";

export type UseVisionBridgeConfigOptions = {
	projectPath?: string;
	modelId?: string;
	provider?: string;
};

export function useVisionBridgeConfig(options?: UseVisionBridgeConfigOptions): VisionBridgeConfig | null {
	const revision = useAtomValue(visionConfigRevisionAtom);
	const [config, setConfig] = useState<VisionBridgeConfig | null>(null);

	useEffect(() => {
		let active = true;
		desktopApi.config
			.visionGetConfig()
			.then((res) => {
				// 成功但 config 为空（如配置被删除）也必须清掉 stale 值，
				// 否则已挂载的 Composer 会一直用旧 vision-bridge 配置显示模型提示。
				if (active) setConfig(res?.config ?? null);
			})
			.catch(() => {
				if (active) setConfig(null);
			});

		return () => {
			active = false;
		};
	}, [options?.projectPath, options?.modelId, options?.provider, revision]);

	return config;
}
