export type WindowResizeEdge =
	| "top"
	| "bottom"
	| "left"
	| "right"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right";

export interface NativeClipboardSnapshot {
	text: string;
	html: string;
	imageDataUrl: string;
	filePaths: string[];
	hasImage: boolean;
	sequence: number;
}

export interface NativeFileDropPayload {
	paths: string[];
	/** WebView client coordinates in CSS pixels, suitable for elementFromPoint. */
	clientX: number;
	clientY: number;
}
