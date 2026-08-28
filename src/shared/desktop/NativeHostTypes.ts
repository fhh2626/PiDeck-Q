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
}

export interface NativeClipboardSnapshot extends NativeClipboardMetadata {
	imageDataUrl: string;
}

export interface NativeFileDropPayload {
	paths: string[];
	/** WebView client coordinates in CSS pixels, suitable for elementFromPoint. */
	clientX: number;
	clientY: number;
}
