import { ipcChannels } from "../../shared/ipc";
import type { AppSettings } from "../../shared/types";
import type { MainWindowControls, WindowState } from "../../main/window/MainWindowControlsContract";
import type { HostBridge } from "./HostBridge";

/** Node-side proxy for Qt window controls; no renderer or business logic lives here. */
export class NativeMainWindowControls implements MainWindowControls {
	private maximized = false;
	private minimized = false;
	private visible = false;
	private destroyed = false;
	private alwaysOnTop = false;

	constructor(
		private readonly host: HostBridge,
		private readonly sendToRenderer: (channel: string, ...args: unknown[]) => void,
	) {
		host.on<boolean>("window.maximizedChanged", (value) => {
			this.maximized = value;
			this.sendToRenderer(ipcChannels.appWindowMaximizedChanged, value);
		});
		host.on<boolean>("window.minimizedChanged", (value) => {
			this.minimized = value;
		});
		host.on<boolean>("window.visibleChanged", (value) => {
			this.visible = value;
		});
	}

	markCreated(): void {
		this.destroyed = false;
		this.visible = true;
	}

	markDestroyed(): void {
		this.destroyed = true;
		this.visible = false;
	}

	getWindowState(): WindowState {
		return {
			isMaximized: this.maximized,
			isMinimized: this.minimized,
			isFullScreen: false,
		};
	}

	minimize(): void {
		void this.host.request("window.minimize").catch(() => undefined);
	}

	maximize(): void {
		void this.host.request("window.maximize").catch(() => undefined);
	}

	unmaximize(): void {
		void this.host.request("window.unmaximize").catch(() => undefined);
	}

	toggleMaximize(): Promise<boolean> {
		return this.host.request<boolean>("window.toggleMaximize");
	}

	isMaximized(): boolean {
		return this.maximized;
	}

	toggleAlwaysOnTop(): Promise<boolean> {
		return this.host.request<boolean>("window.toggleAlwaysOnTop").then((value) => {
			this.alwaysOnTop = value;
			return value;
		});
	}

	close(): void {
		void this.host.request("window.close").catch(() => undefined);
	}

	reload(): void {
		void this.host.request("window.reload").catch(() => undefined);
	}

	focus(): void {
		void this.host.request("window.focus").catch(() => undefined);
	}

	isMinimized(): boolean {
		return this.minimized;
	}

	isVisible(): boolean {
		return this.visible;
	}

	restore(): void {
		void this.host.request("window.restore").catch(() => undefined);
	}

	show(): void {
		void this.host.request("window.show").catch(() => undefined);
	}

	isDestroyed(): boolean {
		return this.destroyed;
	}

	notifyTitleBarChange(settings: AppSettings): void {
		this.sendToRenderer(ipcChannels.settingsApplyWindow, settings);
		void this.host.request("window.applySettings", {
			useNativeTitleBar: settings.useNativeTitleBar,
			closeToTray: settings.closeToTray,
		}).catch(() => undefined);
	}

	toggleDevTools(): void {
		void this.host.request("window.toggleDevTools").catch(() => undefined);
	}

	beginWindowDrag(): void {
		void this.host.request("window.beginSystemMove").catch(() => undefined);
	}
}
