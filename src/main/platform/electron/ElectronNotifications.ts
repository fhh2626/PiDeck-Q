import { Notification } from "electron";
import type {
	PlatformNotificationOptions,
	PlatformNotifications,
} from "../PlatformServices";

/**
 * 生成带会话跳转参数的 Windows toast XML。
 * 使用 activationType="protocol" + pideck:// 协议 URL：点击通知时 Windows 通过
 * 注册表协议关联唤起应用，被唤起实例的 argv 携带协议 URL，主实例据此识别要跳转的会话。
 */
export function buildProtocolToastXml(
	title: string,
	body: string,
	activationUrl?: string,
): string {
	const esc = (s: string) =>
		s
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	const launch = esc(activationUrl || "pideck://");
	return `<toast activationType="protocol" launch="${launch}">
  <visual>
    <binding template="ToastGeneric">
      <text>${esc(title)}</text>
      <text>${esc(body)}</text>
    </binding>
  </visual>
</toast>`;
}

export class ElectronNotifications implements PlatformNotifications {
	isSupported(): boolean {
		return Notification.isSupported();
	}

	show(options: PlatformNotificationOptions): void {
		const notification = new Notification({
			title: options.title,
			body: options.body,
			silent: options.silent ?? false,
			...(options.activationUrl
				? {
						toastXml: buildProtocolToastXml(
							options.title,
							options.body,
							options.activationUrl,
						),
				  }
				: {}),
		});

		if (options.onClick) {
			notification.on("click", options.onClick);
		}
		if (options.onFailed) {
			notification.on("failed", (_event, error) => {
				options.onFailed?.(error);
			});
		}

		notification.show();
	}
}
