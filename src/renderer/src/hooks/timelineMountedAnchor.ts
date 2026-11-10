import type { VirtualTimelineGeometry } from "../components/session/timeline/virtualTimelineGeometry";
import type { RowRegistrationRecord } from "./timelineMeasurementRegistry";

/** A visible row's signed offset, measured from the current DOM rather than estimates. */
export interface MountedTimelineAnchor {
	rowKey: string;
	offsetTop: number;
}

/**
 * Restore a DOM capture using that same row's current DOM position. A tail-only
 * render may precede ResizeObserver's commit, so estimated prefix offsets are
 * not a valid coordinate basis yet. Reads stay O(1), even with offscreen pins.
 */
export function resolveMountedTimelineAnchorScrollTop(input: {
	anchor: MountedTimelineAnchor;
	nodes: ReadonlyMap<string, RowRegistrationRecord>;
	viewport: HTMLElement;
	contextId: number;
	widthEpoch: number;
}): number | null {
	const { anchor, viewport } = input;
	if (viewport.clientHeight <= 0) return null;
	const registration = input.nodes.get(anchor.rowKey);
	if (!registration || registration.contextId !== input.contextId || registration.widthEpoch !== input.widthEpoch
		|| !viewport.contains(registration.node)) return null;
	const rect = registration.node.getBoundingClientRect();
	if (rect.bottom <= rect.top) return null;
	const viewportTop = viewport.getBoundingClientRect().top + viewport.clientTop;
	return viewport.scrollTop + rect.top - viewportTop - anchor.offsetTop;
}

// Probe past a small row gap/header without walking the mounted row registry.
const ANCHOR_PROBE_OFFSETS = [1, 16, 48];

/**
 * Newly mounted Markdown can have its real height before the virtual geometry
 * receives its measurement batch. Hit-test the viewport to capture that real
 * position with bounded DOM reads; never scan all mounted/pinned rows.
 * An unavailable or obstructed hit test returns null for the geometry fallback.
 */
export function captureMountedTimelineAnchor(input: {
	geometry: VirtualTimelineGeometry;
	nodes: ReadonlyMap<string, RowRegistrationRecord>;
	viewport: HTMLElement;
	contextId: number;
	widthEpoch: number;
}): MountedTimelineAnchor | null {
	const { geometry, viewport } = input;
	const doc = viewport.ownerDocument;
	if (viewport.clientHeight <= 0 || typeof doc?.elementFromPoint !== "function") return null;
	const viewportRect = viewport.getBoundingClientRect();
	const viewportTop = viewportRect.top + viewport.clientTop;
	const viewportBottom = viewportTop + viewport.clientHeight;
	const x = viewportRect.left + viewportRect.width / 2;

	// Fast upward scrolling can leave a virtual spacer across the top probes
	// until the next render. A middle/bottom probe can still find a visible row
	// whose real position is usable; do not fall back to stale estimates early.
	const offsets = [...ANCHOR_PROBE_OFFSETS, viewport.clientHeight / 2, viewport.clientHeight - 1].sort((a, b) => a - b);
	for (const offset of offsets) {
		if (viewportTop + offset >= viewportBottom) continue;
		const hit = doc.elementFromPoint(x, viewportTop + offset);
		if (!hit || !viewport.contains(hit)) continue;
		const row = hit.closest("[data-timeline-row-key]");
		const key = row?.getAttribute("data-timeline-row-key");
		if (!row || !key) continue;
		const registration = input.nodes.get(key);
		if (!registration || !row.contains(registration.node)
			|| registration.contextId !== input.contextId || registration.widthEpoch !== input.widthEpoch) continue;
		const index = geometry.indexByKey.get(key);
		if (index === undefined) continue;
		// A probe can fall just below a gap or a short row. Check only the
		// preceding logical row as well, retaining the topmost-row convention.
		const previousKey = geometry.rows[index - 1]?.key;
		for (const candidateKey of previousKey ? [previousKey, key] : [key]) {
			const candidate = input.nodes.get(candidateKey);
			if (!candidate || candidate.contextId !== input.contextId || candidate.widthEpoch !== input.widthEpoch
				|| !viewport.contains(candidate.node)) continue;
			const rect = candidate.node.getBoundingClientRect();
			const candidateIndex = candidateKey === key ? index : index - 1;
			const gapAfter = candidateIndex < geometry.rows.length - 1 ? geometry.gap : 0;
			if (rect.bottom <= rect.top || rect.bottom + gapAfter <= viewportTop || rect.top >= viewportBottom) continue;
			return { rowKey: candidateKey, offsetTop: rect.top - viewportTop };
		}
	}
	return null;
}
