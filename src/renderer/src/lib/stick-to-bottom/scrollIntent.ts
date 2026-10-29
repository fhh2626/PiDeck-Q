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

