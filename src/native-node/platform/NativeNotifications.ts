import type {
	PlatformNotificationOptions,
	PlatformNotifications,
} from "../../main/platform/PlatformServices";
import type { HostBridge } from "../host/HostBridge";

/** Native notification support is currently implemented only by the Windows Qt host. */
export function isNativeNotificationsSupported(platform: NodeJS.Platform = process.platform): boolean {
	return platform === "win32" && process.env.PIDECK_NATIVE_NOTIFICATIONS !== "0";
}

type NativeNotificationResult = {
	backend: "toast" | "tray" | "none";
	interactive: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNativeNotificationResult(value: unknown): value is NativeNotificationResult {
	if (!isRecord(value)) return false;
	return (value.backend === "toast" || value.backend === "tray" || value.backend === "none")
		&& typeof value.interactive === "boolean";
}

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
		host.on<{ id?: string }>("notification.dismissed", (payload) => {
			if (!payload?.id) return;
			this.callbacks.delete(payload.id);
		});
		host.on<{ id?: string; error?: string }>("notification.failed", (payload) => {
			if (!payload?.id) return;
			const options = this.callbacks.get(payload.id);
			if (!options) return;
			this.callbacks.delete(payload.id);
			options.onFailed?.(new Error(payload.error ?? "Native notification failed"));
		});
		host.on<{ id?: string }>("notification.fallback", (payload) => {
			if (!payload?.id) return;
			// Tray messages are deliberately non-interactive. Release the closure as
			// soon as Qt confirms that fallback was selected; no click/dismiss event
			// exists that can safely identify concurrent tray balloons.
			this.callbacks.delete(payload.id);
		});
	}

	isSupported(): boolean {
		return isNativeNotificationsSupported();
	}

	show(options: PlatformNotificationOptions): void {
		const id = `notification-${++this.nextId}`;
		this.callbacks.set(id, options);
		void this.host.request<unknown>("notification.show", {
			id,
			title: options.title,
			body: options.body,
			silent: options.silent ?? false,
			activationUrl: options.activationUrl,
		}).then((result) => {
			if (!isNativeNotificationResult(result)) {
				// Older hosts returned null. Treat that response as non-interactive so
				// an upgrade cannot retain a callback forever on tray fallback.
				this.callbacks.delete(id);
				return;
			}
			if (result.backend === "tray" && !result.interactive) {
				this.callbacks.delete(id);
				return;
			}
			if (result.backend === "none") {
				this.callbacks.delete(id);
				options.onFailed?.(new Error("Native notification backend is unavailable"));
			}
		}).catch((error: unknown) => {
			this.callbacks.delete(id);
			options.onFailed?.(error);
		});
	}
}
