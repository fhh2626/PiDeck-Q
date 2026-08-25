export interface NativeClipboardSnapshot {
	text: string;
	html: string;
	imageDataUrl: string;
	filePaths: string[];
}

export interface NativeFileDropPayload {
	paths: string[];
	x: number;
	y: number;
}
