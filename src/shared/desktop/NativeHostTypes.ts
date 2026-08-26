export interface NativeClipboardSnapshot {
	text: string;
	html: string;
	imageDataUrl: string;
	filePaths: string[];
}

export interface NativeFileDropPayload {
	paths: string[];
	/** WebView client coordinates in CSS pixels, suitable for elementFromPoint. */
	clientX: number;
	clientY: number;
}
