/**
 * Renderer-facing transport contract shared by Electron preload and the native host.
 * The transport owns only RPC/event delivery; the desktop API shape stays identical
 * across runtimes.
 */
export interface DesktopRpcTransport {
	invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
	subscribe<T>(channel: string, callback: (payload: T) => void): () => void;
}

/**
 * Synchronous capabilities needed by paste/drop handlers. These methods deliberately
 * remain synchronous because callers must inspect clipboard data before preventing the
 * browser's default paste behavior.
 */
export interface DesktopSyncHost {
	readClipboardText(): string;
	readClipboardHtml(): string;
	readClipboardImage(): string;
	getPathForFile(file: File): string;
	getClipboardPaths(): string[];
	/** Capability issued by a trusted host for the current external clipboard paths. */
	getClipboardCapability?(): string;
}
