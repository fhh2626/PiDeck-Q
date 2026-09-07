import type {
	PlatformDialogs,
	PlatformOpenDialogOptions,
	PlatformOpenDialogResult,
	PlatformSaveDialogOptions,
	PlatformSaveDialogResult,
} from "../../main/platform/PlatformServices";
import type { HostBridge } from "../host/HostBridge";

/** Qt dialog proxy; options remain the existing PlatformServices contract. */
export class NativeDialogs implements PlatformDialogs {
	constructor(private readonly host: HostBridge) {}

	showOpenDialog(options: PlatformOpenDialogOptions): Promise<PlatformOpenDialogResult> {
		return this.host.request<PlatformOpenDialogResult>("dialog.open", options);
	}

	showSaveDialog(options: PlatformSaveDialogOptions): Promise<PlatformSaveDialogResult> {
		return this.host.request<PlatformSaveDialogResult>("dialog.save", options);
	}
}
