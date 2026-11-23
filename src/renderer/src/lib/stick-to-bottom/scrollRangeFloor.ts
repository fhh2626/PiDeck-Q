/** Keep the engine's offset reachable across layouts that can disappear before observer delivery. */
export function createScrollRangeFloor() {
	let element: HTMLElement | null = null;
	let offset = 0;

	function hold(top: number) {
		const next = Math.floor(Math.max(0, top));
		if (!element || offset === next) return;
		offset = next;
		// This is out-of-flow and never extends the settled range: the engine only
		// records an offset the browser has already allowed. The viewport's height
		// supplies the base, so even a transient viewport expansion cannot clamp.
		element.style.top = next > 0 ? `calc(100% + ${next - 1}px)` : "";
	}

	return {
		attach(next: HTMLElement | null) {
			hold(0);
			element = next;
		},
		hold,
		get offset() { return offset; },
	};
}
