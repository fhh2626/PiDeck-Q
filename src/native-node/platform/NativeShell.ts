import type { PlatformOpenPathResult, PlatformShell } from "../../main/platform/PlatformServices";
import type { HostBridge } from "../host/HostBridge";

/** Qt shell proxy. URL validation remains in the existing external-links gateway. */
export class NativeShell implements PlatformShell {
	constructor(private readonly host: HostBridge) {}

	openExternal(url: string): Promise<void> {
		return this.host.request("shell.openExternal", { url });
	}

	openPath(path: string): Promise<PlatformOpenPathResult> {
		return this.host.request<PlatformOpenPathResult>("shell.openPath", { path });
	}

	async showItemInFolder(path: string): Promise<void> {
		const result = await this.host.request<PlatformOpenPathResult>("shell.showItemInFolder", { path });
		if (!result?.ok) throw new Error(result?.error ?? "Unable to reveal the path");
	}

	trashItem(path: string): Promise<void> {
		return this.host.request("shell.trashItem", { path });
	}
}
