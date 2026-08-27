import type { WindowResizeEdge } from "../../shared/desktop/NativeHostTypes";
import type { AppSettings } from "../../shared/types";

export type WindowState = {
	isMaximized: boolean;
	isMinimized: boolean;
	isFullScreen: boolean;
};

/** Electron-free window host contract shared by Electron and Qt adapters. */
export interface MainWindowControls {
	getWindowState(): WindowState;
	minimize(): void;
	maximize(): void;
	unmaximize(): void;
	toggleMaximize(): boolean | Promise<boolean>;
	isMaximized(): boolean;
	toggleAlwaysOnTop(): boolean | Promise<boolean>;
	close(): void;
	reload(): void;
	focus(): void;
	isMinimized(): boolean;
	isVisible(): boolean;
	restore(): void;
	show(): void;
	isDestroyed(): boolean;
	notifyTitleBarChange(settings: AppSettings): void;
	toggleDevTools(): void;
	beginWindowDrag?(): void;
	beginWindowResize?(edge: WindowResizeEdge): void;
}
