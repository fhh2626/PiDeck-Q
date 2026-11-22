import { findVisibleRowRange, type VirtualTimelineGeometry } from "../components/session/timeline/virtualTimelineGeometry";
import type { RowRegistrationRecord } from "./timelineMeasurementRegistry";

/** A visible row's signed offset, measured from the current DOM rather than estimates. */
export interface MountedTimelineAnchor {
	rowKey: string;
	offsetTop: number;
}

interface MountedTimelineRows {
	nodes: ReadonlyMap<string, RowRegistrationRecord>;
	viewport: HTMLElement;
	contextId: number;
	widthEpoch: number;
}

/** Read a row's real dimensions before React commits the next geometry snapshot. */
export function readMountedTimelineRow(input: MountedTimelineRows, rowKey: string): DOMRect | null {
	if (input.viewport.clientHeight <= 0) return null;
	const registration = input.nodes.get(rowKey);
	if (!registration || registration.contextId !== input.contextId || registration.widthEpoch !== input.widthEpoch
		|| !input.viewport.contains(registration.node)) return null;
	const rect = registration.node.getBoundingClientRect();
	return rect.bottom > rect.top ? rect : null;
}

/**
 * Restore a DOM capture using that same row's current DOM position. A tail-only
 * render may precede ResizeObserver's commit, so estimated prefix offsets are
 * not a valid coordinate basis yet. Reads stay O(1), even with offscreen pins.
 */
export function resolveMountedTimelineAnchorScrollTop(input: MountedTimelineRows & {
	anchor: MountedTimelineAnchor;
	edge?: "bottom";
}): number | null {
	const { anchor, viewport } = input;
	const rect = readMountedTimelineRow(input, anchor.rowKey);
	if (!rect) return null;
	const viewportTop = viewport.getBoundingClientRect().top + viewport.clientTop;
	const edge = input.edge === "bottom" ? rect.bottom : rect.top;
	return viewport.scrollTop + edge - viewportTop - anchor.offsetTop;
}

/** Locate the exact spacer at the top; mounted rows can make estimated list prefixes stale. */
export function readTimelineSpacerLanding(geometry: VirtualTimelineGeometry, list: HTMLElement | null, viewport: HTMLElement) {
	if (!list || viewport.clientHeight <= 0 || !viewport.contains(list)) return null;
	const top = viewport.getBoundingClientRect().top + viewport.clientTop;
	// Spacers deliberately ignore pointer hit testing. Binary-search the normal
	// flow children instead of scanning rows or changing their pointer behavior.
	let low = 0;
	let high = list.children.length - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const child = list.children[mid];
		const rect = child.getBoundingClientRect();
		if (rect.top > top) high = mid - 1;
		else if (rect.bottom <= top) low = mid + 1;
		else {
			const span = /^spacer:(\d+)-(\d+)$/.exec(child.getAttribute("data-virtual-spacer") ?? "");
			if (!span) return null;
			const start = Number(span[1]);
			const end = Number(span[2]);
			const localTop = geometry.prefixOffsets[start] + top - rect.top;
			if (Math.abs(geometry.prefixOffsets[end] - geometry.prefixOffsets[start] - rect.height) > 1) return null;
			const index = findVisibleRowRange(geometry, localTop, 1, 0).startIndex;
			return index >= start && index < end ? { index, localTop } : null;
		}
	}
	return null;
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
