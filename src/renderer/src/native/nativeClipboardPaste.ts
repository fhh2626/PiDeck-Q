/**
 * Native WebView paste events cannot expose Windows CF_HDROP paths. Text/HTML
 * is authoritative when present; file/image or empty events require a live Qt
 * snapshot so an older SSE cache can never decide what gets pasted.
 */
export function shouldRequestNativeClipboardSnapshot(
	clipboardData: Pick<DataTransfer, "getData" | "items">,
): boolean {
	const hasFileItem = Array.from(clipboardData.items).some((item) => item.kind === "file");
	if (hasFileItem) return true;
	return !clipboardData.getData("text/plain") && !clipboardData.getData("text/html");
}
