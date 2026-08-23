import { app, session } from "electron";
import type { PlatformProxy, PlatformProxyConfig } from "../PlatformServices";

export class ElectronProxy implements PlatformProxy {
	async apply(config: PlatformProxyConfig): Promise<void> {
		// 严格顺序：session.defaultSession.setProxy 先于 app.setProxy
		await session.defaultSession.setProxy(config);
		await app.setProxy(config);
	}
}
