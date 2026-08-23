import type { AppSettings } from "../../shared/types";

export interface BrowserWindowOptionsSlice {
	frame: boolean;
	titleBarStyle: "default" | "hiddenInset" | "hidden";
	trafficLightPosition?: { x: number; y: number };
}

export function createWindowOptions(
	settings: AppSettings,
	platform: NodeJS.Platform = process.platform,
): BrowserWindowOptionsSlice {
	const useNative = settings.useNativeTitleBar;
	const isMac = platform === "darwin";

	return {
		frame: useNative,
		titleBarStyle: useNative
			? ("default" as const)
			: isMac
				? ("hiddenInset" as const)
				: ("hidden" as const),
		// 系统标题栏模式下红绿灯由 macOS 控制，不设置避免与侧栏 logo 重叠。
		...(!useNative && isMac
			? { trafficLightPosition: { x: 14, y: 14 } as const }
			: {}),
	};
}
