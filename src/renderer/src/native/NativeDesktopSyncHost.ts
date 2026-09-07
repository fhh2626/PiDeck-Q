import type { DesktopSyncHost } from "@shared/desktop/DesktopRpcTransport";
import type { NativeClipboardMetadata, NativeClipboardSnapshot } from "@shared/desktop/NativeHostTypes";

export type { NativeClipboardMetadata, NativeClipboardSnapshot } from "@shared/desktop/NativeHostTypes";

type NativeClipboardUpdate = Partial<NativeClipboardMetadata> & {
	/** Full snapshots from compatibility hosts may still carry encoded image data. */
	imageDataUrl?: string;
};

/**
 * Synchronous renderer cache for native clipboard and OS file-drop data.
 * The Qt host publishes snapshots over SSE; paste handlers continue to read this
 * cache synchronously so their preventDefault timing remains unchanged.
 */
export class NativeDesktopSyncHost implements DesktopSyncHost {
	private snapshot: NativeClipboardSnapshot;

	constructor(snapshot?: NativeClipboardUpdate) {
		this.snapshot = {
			text: snapshot?.text ?? "",
			html: snapshot?.html ?? "",
			imageDataUrl: snapshot?.imageDataUrl ?? "",
			filePaths: snapshot?.filePaths ?? [],
			hasImage: snapshot?.hasImage ?? Boolean(snapshot?.imageDataUrl),
			sequence: snapshot?.sequence ?? 0,
			externalFileCapabilityId: snapshot?.externalFileCapabilityId,
		};
	}

	update(snapshot: NativeClipboardUpdate): void {
		this.snapshot = {
			...this.snapshot,
			...snapshot,
			// Metadata events intentionally omit image bytes. Clear the previous
			// encoded image so a later synchronous read cannot return stale data.
			imageDataUrl: snapshot.imageDataUrl ?? "",
			filePaths: snapshot.filePaths ?? this.snapshot.filePaths,
			externalFileCapabilityId: snapshot.externalFileCapabilityId,
		};
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

	getPathForFile(_file: File): string {
		// Native WebView File objects do not expose a reliable absolute path. OS
		// drops and clipboard file lists are delivered separately with their full
		// paths; never guess by basename because equal names can come from different
		// directories.
		return "";
	}

	getClipboardPaths(): string[] {
		return [...this.snapshot.filePaths];
	}

	getClipboardCapability(): string {
		return this.snapshot.externalFileCapabilityId ?? "";
	}
}
