/**
 * PlatformServices (src/main/platform/PlatformServices.ts)
 *
 * 平台能力抽象接口定义（Electron-free contract）。
 * 业务模块只能依赖本文件定义的纯接口与数据结构，不得直接 import Electron。
 */

export interface PlatformPaths {
	readonly home: string;
	readonly userData: string;
	readonly appPath: string;
	readonly resourcesPath: string;
	readonly downloads?: string;
}

export interface PlatformApplication {
	readonly name: string;
	readonly version: string;
	readonly isPackaged: boolean;

	getLocale(): string;
	getPreferredSystemLanguages(): string[];

	hideApplicationMenu(): void;
}

export type PlatformOpenDialogProperty =
	| "openFile"
	| "openDirectory"
	| "multiSelections";

export interface PlatformFileFilter {
	name: string;
	extensions: string[];
}

export interface PlatformOpenDialogOptions {
	title?: string;
	defaultPath?: string;
	filters?: PlatformFileFilter[];
	properties: PlatformOpenDialogProperty[];
	parent?: "main-window" | "none";
}

export interface PlatformOpenDialogResult {
	canceled: boolean;
	filePaths: string[];
}

export interface PlatformSaveDialogOptions {
	title?: string;
	defaultPath?: string;
	filters?: PlatformFileFilter[];
	parent?: "main-window" | "none";
}

export interface PlatformSaveDialogResult {
	canceled: boolean;
	filePath?: string;
}

export interface PlatformDialogs {
	showOpenDialog(
		options: PlatformOpenDialogOptions,
	): Promise<PlatformOpenDialogResult>;

	showSaveDialog(
		options: PlatformSaveDialogOptions,
	): Promise<PlatformSaveDialogResult>;
}

export type PlatformOpenPathResult =
	| { ok: true }
	| { ok: false; error: string };

export interface PlatformShell {
	openExternal(url: string): Promise<void>;
	openPath(path: string): Promise<PlatformOpenPathResult>;
	showItemInFolder(path: string): void;
	trashItem(path: string): Promise<void>;
}

export interface PlatformNotificationOptions {
	title: string;
	body: string;
	silent?: boolean;
	activationUrl?: string;
	onClick?: () => void;
	onFailed?: (error: unknown) => void;
}

export interface PlatformNotifications {
	isSupported(): boolean;
	show(options: PlatformNotificationOptions): void;
}

export interface PlatformTheme {
	setSource(source: "system" | "light" | "dark"): void;
}

export type PlatformProxyConfig =
	| {
			mode: "direct";
	  }
	| {
			mode: "fixed_servers";
			proxyRules: string;
			proxyBypassRules?: string;
	  };

export interface PlatformProxy {
	apply(config: PlatformProxyConfig): Promise<void>;
}

export interface PlatformDownloadProgress {
	receivedBytes: number;
	totalBytes?: number;
}

export interface PlatformDownloadRequest {
	url: string;
	filePath: string;
	headers?: Record<string, string>;
	expectedBytes?: number;
	onRedirect?: (url: string) => void;
	onProgress?: (progress: PlatformDownloadProgress) => void;
}

export class PlatformDownloadError extends Error {
	readonly statusCode?: number;

	constructor(message: string, statusCode?: number) {
		super(message);
		this.name = "PlatformDownloadError";
		this.statusCode = statusCode;
	}
}

export interface PlatformDownloads {
	downloadToFile(
		request: PlatformDownloadRequest,
	): Promise<{
		receivedBytes: number;
		totalBytes?: number;
	}>;
}

export interface PlatformServices {
	readonly paths: PlatformPaths;
	readonly application: PlatformApplication;
	readonly dialogs: PlatformDialogs;
	readonly shell: PlatformShell;
	readonly notifications: PlatformNotifications;
	readonly theme: PlatformTheme;
	readonly proxy: PlatformProxy;
	readonly downloads: PlatformDownloads;
	readonly fetch?: typeof globalThis.fetch;
}
