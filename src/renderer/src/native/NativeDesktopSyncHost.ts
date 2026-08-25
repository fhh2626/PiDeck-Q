import type { DesktopSyncHost } from "@shared/desktop/DesktopRpcTransport";
import type { NativeClipboardSnapshot } from "@shared/desktop/NativeHostTypes";

export type { NativeClipboardSnapshot } from "@shared/desktop/NativeHostTypes";

/**
 * Synchronous renderer cache for native clipboard and OS file-drop data.
 * The Qt host publishes snapshots over SSE; paste handlers continue to read this
 * cache synchronously so their preventDefault timing remains unchanged.
 */
export class NativeDesktopSyncHost implements DesktopSyncHost {
	private snapshot: NativeClipboardSnapshot;
	private readonly filePathsByName = new Map<string, string>();

	constructor(snapshot?: Partial<NativeClipboardSnapshot>) {
		this.snapshot = {
			text: snapshot?.text ?? "",
			html: snapshot?.html ?? "",
			imageDataUrl: snapshot?.imageDataUrl ?? "",
			filePaths: snapshot?.filePaths ?? [],
		};
		this.rememberFilePaths(this.snapshot.filePaths);
	}

	update(snapshot: Partial<NativeClipboardSnapshot>): void {
		this.snapshot = {
			...this.snapshot,
			...snapshot,
			filePaths: snapshot.filePaths ?? this.snapshot.filePaths,
		};
		this.rememberFilePaths(this.snapshot.filePaths);
	}

	rememberFilePaths(paths: string[]): void {
		for (const path of paths) {
			const name = path.split(/[\\/]/).pop();
			if (name) this.filePathsByName.set(name, path);
		}
	}

	readClipboardText(): string {
		return this.snapshot.text;
	}

	readClipboardHtml(): string {
		return this.snapshot.html;
	}

	readClipboardImage(): string {
		return this.snapshot.imageDataUrl;
	}

	getPathForFile(file: File): string {
		return this.filePathsByName.get(file.name) ?? "";
	}

	getClipboardPaths(): string[] {
		return [...this.snapshot.filePaths];
	}
}
