/**
 * Custom titlebar drag hit-testing for the native (Qt) host.
 *
 * Electron can honor `-webkit-app-region: drag` on overlapping chrome.
 * Qt WebView does not, so the renderer must start a system move from the
 * real pointer target. Logo / session tabs sit above `.window-drag-layer`
 * (z-index 930 vs 900); a capture-phase listener uses this helper so those
 * visible regions still drag the window without swallowing buttons or tabs.
 */

const INTERACTIVE_SELECTOR = [
	"button",
	"a",
	"input",
	"textarea",
	"select",
	"[role='button']",
	"[role='tab']",
	"[role='menuitem']",
	"[role='combobox']",
	"[contenteditable='true']",
	"[data-no-window-drag]",
].join(",");

const TITLEBAR_SELECTOR = [
	".window-drag-layer",
	".list-toolbar",
	".session-tabs-bar",
	".app-badge",
].join(",");

export type WindowChromeClosest = (selector: string) => boolean;

/** Minimal ancestor record so tests can exercise closest() semantics without jsdom. */
export type WindowChromeAncestor = {
	tagName?: string;
	className?: string;
	role?: string;
	contentEditable?: boolean;
	noWindowDrag?: boolean;
};

/**
 * Match one simple selector used by the titlebar hit test.
 * Combinators are intentionally unsupported; keep the production selectors simple.
 */
export function ancestorMatchesSelector(node: WindowChromeAncestor, selector: string): boolean {
	const sel = selector.trim();
	if (!sel) return false;
	if (sel.startsWith(".")) {
		const className = sel.slice(1);
		return Boolean(node.className?.split(/\s+/).includes(className));
	}
	if (sel === "[data-no-window-drag]") return Boolean(node.noWindowDrag);
	if (sel.startsWith("[role=")) {
		const role = /\[role=['"]([^'"]+)['"]\]/.exec(sel)?.[1];
		return Boolean(role && node.role === role);
	}
	if (sel.startsWith("[contenteditable")) return Boolean(node.contentEditable);
	return node.tagName?.toLowerCase() === sel.toLowerCase();
}

function closestFromAncestors(
	ancestors: readonly WindowChromeAncestor[],
	selector: string,
): boolean {
	return selector.split(",").some((part) => {
		const simple = part.trim();
		return ancestors.some((node) => ancestorMatchesSelector(node, simple));
	});
}

/**
 * Pure hit test used by the titlebar capture listener and unit tests.
 * Interactive chrome (tabs, buttons, inputs) stays clickable.
 */
export function shouldBeginWindowDragFromClosest(matches: WindowChromeClosest): boolean {
	if (matches(".window-controls")) return false;
	if (matches(INTERACTIVE_SELECTOR)) return false;
	return matches(TITLEBAR_SELECTOR);
}

export function shouldBeginWindowDragFromAncestors(
	ancestors: readonly WindowChromeAncestor[],
): boolean {
	return shouldBeginWindowDragFromClosest((selector) => closestFromAncestors(ancestors, selector));
}

/** True when a left-button press on `target` should start a native window drag. */
export function shouldBeginWindowDrag(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	return shouldBeginWindowDragFromClosest((selector) => Boolean(target.closest(selector)));
}
