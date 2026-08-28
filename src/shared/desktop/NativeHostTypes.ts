export type WindowResizeEdge =
	| "top"
	| "bottom"
	| "left"
	| "right"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right";

export interface NativeClipboardMetadata {
	text: string;
	html: string;
	filePaths: string[];
	hasImage: boolean;
	sequence: number;
	/** Issued by the trusted native host; renderer paths alone are never sufficient for external reads/copies. */
	externalFileCapabilityId?: string;
}

export interface NativeClipboardSnapshot extends NativeClipboardMetadata {
	imageDataUrl: string;
}

export interface NativeFileDropPayload {
	paths: string[];
	/** Issued by the trusted native host for one external copy/read operation. */
	externalFileCapabilityId?: string;
	/** WebView client coordinates in CSS pixels, suitable for elementFromPoint. */
	clientX: number;
	clientY: number;
}
