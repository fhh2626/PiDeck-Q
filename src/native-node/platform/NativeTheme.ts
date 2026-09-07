import type { PlatformTheme } from "../../main/platform/PlatformServices";
import type { HostBridge } from "../host/HostBridge";

export class NativeTheme implements PlatformTheme {
	constructor(private readonly host: HostBridge) {}

	setSource(source: "system" | "light" | "dark"): void {
		void this.host.request("theme.setSource", { source }).catch(() => undefined);
	}
}
