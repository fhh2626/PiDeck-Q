import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { isVerticalScrollbarPress } = loadTsCommonJs("src/renderer/src/lib/stick-to-bottom/scrollIntent.ts", {
	globals: { window: { getComputedStyle: (node) => node.computedStyle } },
});

/** Native renderer zoom scales DOM rectangles, while client/offset dimensions remain layout pixels. */
function viewportGeometry({ scale, rtl = false, gutter = 16, border = 0 }) {
	const width = 400 + gutter + border * 2;
	return {
		clientWidth: 400,
		clientHeight: 500,
		clientLeft: border + (rtl ? gutter : 0),
		clientTop: border,
		offsetWidth: width,
		offsetHeight: 500 + border * 2,
		scrollHeight: 2000,
		computedStyle: { borderLeftWidth: `${border}px`, borderRightWidth: `${border}px`, borderTopWidth: `${border}px`, borderBottomWidth: `${border}px`, direction: rtl ? "rtl" : "ltr" },
		getBoundingClientRect: () => ({ left: 100, top: 40, width: width * scale, height: (500 + border * 2) * scale }),
	};
}

for (const scale of [0.8, 1, 1.5]) {
	test(`native scrollbar input uses one coordinate system at ${scale * 100}% renderer zoom`, () => {
		const viewport = viewportGeometry({ scale });
		const press = (layoutX) => ({ target: viewport, button: 0, clientX: 100 + layoutX * scale, clientY: 40 + 250 * scale });
		assert.equal(isVerticalScrollbarPress(press(408), viewport), true, "the actual right scrollbar must stay reachable after zoom");
		assert.equal(isVerticalScrollbarPress(press(350), viewport), false, "zoomed content whitespace must not cancel follow mode");
	});

	test(`an RTL scrollbar keeps its full hit area at ${scale * 100}% renderer zoom`, () => {
		const viewport = viewportGeometry({ scale, rtl: true });
		const press = (layoutX) => ({ target: viewport, button: 0, clientX: 100 + layoutX * scale, clientY: 40 + 250 * scale });
		assert.equal(isVerticalScrollbarPress(press(14), viewport), true);
		assert.equal(isVerticalScrollbarPress(press(18), viewport), false);
		assert.equal(isVerticalScrollbarPress(press(410), viewport), false);
	});
}

test("an overlay viewport with no reserved gutter does not turn zoomed content into a scrollbar", () => {
	const viewport = viewportGeometry({ scale: 1.5, gutter: 0 });
	assert.equal(isVerticalScrollbarPress({ target: viewport, button: 0, clientX: 695, clientY: 300 }, viewport), false);
});

test("viewport borders are not native scrollbar hit targets", () => {
	const viewport = viewportGeometry({ scale: 1, gutter: 0, border: 2 });
	for (const layoutX of [1, 403]) {
		assert.equal(isVerticalScrollbarPress({ target: viewport, button: 0, clientX: 100 + layoutX, clientY: 290 }, viewport), false);
	}
});
