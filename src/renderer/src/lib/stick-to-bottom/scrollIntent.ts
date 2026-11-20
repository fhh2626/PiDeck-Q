/**
 * 时间线用户滚动意图判定（纯函数）。
 *
 * 识别用户上滚、快捷键导航、嵌套滚动区归属等，
 * 避免把内部代码块/工具输出滚动或输入框内光标移动误判为时间线逃逸。
 */

/**
 * 寻找事件目标沿 DOM 树向上最近的纵向可滚动容器。
 * 使用 overflowY 与实际 scrollHeight > clientHeight 双重判定，不依赖 overflow 简写。
 */
export function findNearestVerticalScrollableAncestor(
	target: EventTarget | null,
	boundary: HTMLElement | null,
): HTMLElement | null {
	if (!target || typeof (target as HTMLElement).parentElement === "undefined") {
		return null;
	}
	let current = target as HTMLElement | null;
	while (current && current !== boundary) {
		if (typeof window !== "undefined" && current.nodeType === Node.ELEMENT_NODE) {
			const style = window.getComputedStyle(current);
			const overflowY = style.overflowY;
			if (
				(overflowY === "auto" || overflowY === "scroll") &&
				current.scrollHeight > current.clientHeight
			) {
				return current;
			}
		}
		current = current.parentElement;
	}
	return null;
}

/**
 * 判定「scrollTop 变小」是否只是内容收缩后浏览器自动夹到底部。
 *
 * 内容动画/虚拟行替换会让 scrollHeight 缩水，浏览器把 scrollTop 夹到新的
 * maxScrollTop，看起来像用户上滚。判定需要两个证据：原本锁底、scrollTop
 * 紧贴新的底部，或先前的位置已超过缩短后的可滚动范围。后者覆盖折叠和
 * 新气泡插入发生在同一次 scroll 通知之前，夹取后又留出底部空隙的情况。
 * 已识别的滚轮、触摸、按键和滚动条按压会先退出 following，再走此几何判断。
 */
export function isContentShrinkClamp(input: {
	scrollTop: number;
	lastScrollTop: number;
	maxScrollTop: number;
	previousMaxScrollTop?: number;
	resizeDifference?: number;
	isFollowing: boolean;
	tolerancePx?: number;
}): boolean {
	if (!input.isFollowing) return false;
	// 内容真的缩短是 clamp 的前提。previousMaxScrollTop 是上一帧的最大可滚动
	// 距离，比 lastScrollTop 更可靠（贴底时可能有亚像素差）。首帧没有上一帧
	// 值时，退回 ResizeObserver 的负增长证据；两者都没有则不判 clamp。
	const contentShrank = input.previousMaxScrollTop !== undefined
		? input.maxScrollTop < input.previousMaxScrollTop
		: (input.resizeDifference !== undefined && input.resizeDifference < 0)
			|| input.maxScrollTop < input.lastScrollTop;
	if (!contentShrank) return false;
	const tolerance = input.tolerancePx ?? 2;
	// Require both a measured range reduction and an unreachable former position.
	// Merely being near the bottom must never hide an ordinary upward scroll.
	const formerPositionWasClamped = input.previousMaxScrollTop !== undefined
		&& input.maxScrollTop < input.previousMaxScrollTop
		&& input.lastScrollTop > input.maxScrollTop + tolerance
		&& input.scrollTop <= input.maxScrollTop;
	return input.scrollTop < input.lastScrollTop
		&& (Math.abs(input.scrollTop - input.maxScrollTop) <= tolerance || formerPositionWasClamped);
}

/** Detect a press in a native vertical scrollbar before its first scroll event. */
export function isVerticalScrollbarPress(event: PointerEvent, viewport: HTMLElement | null): boolean {
	if (!viewport || event.target !== viewport || event.button !== 0) return false;
	if (viewport.scrollHeight <= viewport.clientHeight) return false;
	const rect = viewport.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0 || viewport.offsetWidth <= 0 || viewport.offsetHeight <= 0) return false;
	// Renderer zoom scales client coordinates and DOM rectangles, while the
	// client/offset dimensions remain layout pixels. Compare in that latter space.
	const x = (event.clientX - rect.left) * viewport.offsetWidth / rect.width;
	const y = (event.clientY - rect.top) * viewport.offsetHeight / rect.height;
	if (y < viewport.clientTop || y >= viewport.clientTop + viewport.clientHeight) return false;
	const style = typeof window !== "undefined" && typeof window.getComputedStyle === "function"
		? window.getComputedStyle(viewport)
		: undefined;
	const borderLeft = Number.parseFloat(style?.borderLeftWidth ?? "0") || 0;
	const borderRight = Number.parseFloat(style?.borderRightWidth ?? "0") || 0;
	// clientLeft includes the scrollbar for RTL viewports. A child content press
	// or a border cannot match this gutter, so clicking either keeps follow intent.
	return (x >= borderLeft && x < viewport.clientLeft)
		|| (x >= viewport.clientLeft + viewport.clientWidth && x < viewport.offsetWidth - borderRight);
}

/**
 * 判断事件目标是否为可编辑区域或表单交互控件。
 * 处于 input / textarea / contenteditable / ProseMirror 内部时，按键不影响外层时间线。
 */
export function isEditableOrInteractiveTarget(target: EventTarget | null): boolean {
	if (!target || typeof (target as HTMLElement).closest === "undefined") {
		return false;
	}
	const el = target as HTMLElement;
	if (el.isContentEditable) return true;
	const tag = el.tagName.toLowerCase();
	if (tag === "input" || tag === "textarea" || tag === "select") return true;
	if (el.closest?.(".ProseMirror, [contenteditable='true'], input, textarea, select")) {
		return true;
	}
	return false;
}

/**
 * 判定键盘事件是否包含明确的「向上/翻页阅读」意图。
 * 仅在无 Ctrl/Alt/Meta 组合键、且目标不是输入控件时处理：
 * - ArrowUp
 * - PageUp
 * - Home
 * - Shift + Space
 */
export function isTimelineUpwardKeyIntent(event: KeyboardEvent): boolean {
	if (event.defaultPrevented) return false;
	if (event.ctrlKey || event.altKey || event.metaKey) return false;
	if (isEditableOrInteractiveTarget(event.target)) return false;

	const key = event.key;
	if (key === "ArrowUp" || key === "PageUp" || key === "Home") {
		return true;
	}
	if (key === " " && event.shiftKey) {
		return true;
	}
	return false;
}

/**
 * 校验 Touch / Pointer / Key 事件是否发生在内部嵌套的可滚动容器中。
 * 若在内部容器内，则手势或按键操作属于内部局部滚动，不应引起外层时间线逃逸。
 */
export function isNestedScrollEvent(
	target: EventTarget | null,
	boundary: HTMLElement | null,
): boolean {
	const nested = findNearestVerticalScrollableAncestor(target, boundary);
	return Boolean(nested && nested !== boundary);
}

