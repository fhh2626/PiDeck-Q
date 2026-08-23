import type { BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { AppSettings } from "../../shared/types";
import { toggleMainWindowDevTools } from "../devTools";

export type WindowState = {
	isMaximized: boolean;
	isMinimized: boolean;
	isFullScreen: boolean;
};

export interface MainWindowControls {
	getWindowState(): WindowState;
	minimize(): void;
	maximize(): void;
	unmaximize(): void;
	toggleMaximize(): boolean;
	isMaximized(): boolean;
	toggleAlwaysOnTop(): boolean;
	close(): void;
	reload(): void;
	focus(): void;
	isMinimized(): boolean;
	isVisible(): boolean;
	restore(): void;
	show(): void;
	isDestroyed(): boolean;
	setZoomFactor(value: number): void;
	notifyTitleBarChange(settings: AppSettings): void;
	toggleDevTools(): void;
}

export function createElectronMainWindowControls(
	getMainWindow: () => BrowserWindow | null,
	sendToRenderer?: (channel: string, ...args: unknown[]) => void,
): MainWindowControls {
	const maximizedByWindow = new WeakMap<BrowserWindow, boolean>();

	const emitMaximizedState = (win: BrowserWindow, isMaximized: boolean) => {
		maximizedByWindow.set(win, isMaximized);
		if (sendToRenderer) {
			sendToRenderer(ipcChannels.appWindowMaximizedChanged, isMaximized);
		} else if (!win.isDestroyed()) {
			win.webContents.send(ipcChannels.appWindowMaximizedChanged, isMaximized);
		}
	};

	const wireMaximizeEvents = (win: BrowserWindow) => {
		if ((win as unknown as { __maximizeWired?: boolean }).__maximizeWired) return;
		(win as unknown as { __maximizeWired?: boolean }).__maximizeWired = true;
		win.on("maximize", () => emitMaximizedState(win, true));
		win.on("unmaximize", () => emitMaximizedState(win, false));
	};

	const readMaximized = (win: BrowserWindow): boolean =>
		maximizedByWindow.get(win) ?? win.isMaximized();

	const getWin = () => {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return null;
		wireMaximizeEvents(win);
		return win;
	};

	return {
		getWindowState(): WindowState {
			const win = getWin();
			if (!win) {
				return { isMaximized: false, isMinimized: false, isFullScreen: false };
			}
			return {
				isMaximized: readMaximized(win),
				isMinimized: win.isMinimized(),
				isFullScreen: win.isFullScreen(),
			};
		},
		minimize(): void {
			getWin()?.minimize();
		},
		maximize(): void {
			const win = getWin();
			if (!win) return;
			win.maximize();
			emitMaximizedState(win, true);
		},
		unmaximize(): void {
			const win = getWin();
			if (!win) return;
			win.unmaximize();
			emitMaximizedState(win, false);
		},
		toggleMaximize(): boolean {
			const win = getWin();
			if (!win) return false;
			const nextMaximized = !readMaximized(win);
			if (nextMaximized) {
				win.maximize();
			} else {
				win.unmaximize();
			}
			emitMaximizedState(win, nextMaximized);
			return nextMaximized;
		},
		isMaximized(): boolean {
			const win = getWin();
			if (!win) return false;
			return readMaximized(win);
		},
		toggleAlwaysOnTop(): boolean {
			const win = getWin();
			if (!win) return false;
			const next = !win.isAlwaysOnTop();
			win.setAlwaysOnTop(next, "floating");
			return next;
		},
		close(): void {
			getWin()?.close();
		},
		reload(): void {
			getWin()?.webContents.reload();
		},
		focus(): void {
			const win = getWin();
			if (!win) return;
			if (win.isMinimized()) win.restore();
			if (!win.isVisible()) win.show();
			win.focus();
		},
		isMinimized(): boolean {
			return getWin()?.isMinimized() ?? false;
		},
		isVisible(): boolean {
			return getWin()?.isVisible() ?? false;
		},
		restore(): void {
			getWin()?.restore();
		},
		show(): void {
			getWin()?.show();
		},
		isDestroyed(): boolean {
			const win = getMainWindow();
			return !win || win.isDestroyed();
		},
		setZoomFactor(value: number): void {
			const win = getWin();
			if (!win) return;
			win.webContents.setZoomFactor(value);
		},
		notifyTitleBarChange(settings: AppSettings): void {
			const win = getWin();
			if (!win) return;
			if (sendToRenderer) {
				sendToRenderer("settings:apply-window", settings);
			} else if (!win.isDestroyed()) {
				win.webContents.send("settings:apply-window", settings);
			}
		},
		toggleDevTools(): void {
			const win = getWin();
			if (!win) return;
			toggleMainWindowDevTools(win);
		},
	};
}
