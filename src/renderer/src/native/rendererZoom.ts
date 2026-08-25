const MIN_RENDERER_ZOOM = 0.8;
const MAX_RENDERER_ZOOM = 1.5;

/** Apply the persisted zoom setting without relying on Electron webContents APIs. */
export function applyRendererZoom(factor: number): void {
	const normalized = Number.isFinite(factor)
		? Math.min(MAX_RENDERER_ZOOM, Math.max(MIN_RENDERER_ZOOM, factor))
		: 1;
	document.documentElement.style.zoom = String(normalized);
}
