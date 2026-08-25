import type {
	PlatformNotificationOptions,
	PlatformNotifications,
} from "../../main/platform/PlatformServices";
import type { HostBridge } from "../host/HostBridge";

/** Windows toast/desktop notification proxy owned by Qt. */
export class NativeNotifications implements PlatformNotifications {
	private nextId = 0;
	private readonly callbacks = new Map<string, PlatformNotificationOptions>();

	constructor(private readonly host: HostBridge) {
		host.on<{ id?: string }>("notification.clicked", (payload) => {
			if (!payload?.id) return;
			const options = this.callbacks.get(payload.id);
			if (!options) return;
			this.callbacks.delete(payload.id);
			options.onClick?.();
		});
		host.on<{ id?: string; error?: string }>("notification.failed", (payload) => {
			if (!payload?.id) return;
			const options = this.callbacks.get(payload.id);
			if (!options) return;
			this.callbacks.delete(payload.id);
			options.onFailed?.(new Error(payload.error ?? "Native notification failed"));
		});
	}

	isSupported(): boolean {
		return process.platform === "win32" || process.platform === "linux" || process.platform === "darwin";
	}

	show(options: PlatformNotificationOptions): void {
		const id = `notification-${++this.nextId}`;
		this.callbacks.set(id, options);
		void this.host.request("notification.show", {
			id,
			title: options.title,
			body: options.body,
			silent: options.silent ?? false,
			activationUrl: options.activationUrl,
		}).catch((error: unknown) => {
			this.callbacks.delete(id);
			options.onFailed?.(error);
		});
	}
}
