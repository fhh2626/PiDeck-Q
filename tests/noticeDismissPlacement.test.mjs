import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 回归：dismissNotice 曾按“当前 Toaster 是否已挂载”决定关闭哪一侧。
 * Toaster 挂载前弹出的兜底通知，在挂载后关闭时被交给 sonner（空操作），
 * 不自动消失的通知（如“实时更新连接中断”）就会在恢复后永久残留。
 */

function loadNotice() {
	const { window } = parseHTML("<html><body></body></html>");
	const sonnerDismissed = [];
	let nextToastId = 100;
	const toast = Object.assign(() => nextToastId++, {
		dismiss: (id) => sonnerDismissed.push(id),
		error: () => nextToastId++,
		warning: () => nextToastId++,
		info: () => nextToastId++,
	});
	const notice = loadTsCommonJs("src/renderer/src/utils/notice.ts", {
		stubs: {
			sonner: { toast },
			"../i18n": { t: (key) => key },
		},
		globals: {
			window: Object.assign(window, { setTimeout, clearTimeout }),
			document: window.document,
			CSS: { escape: (value) => String(value).replace(/["\\]/g, "\\$&") },
		},
	});
	const fallbackItems = () => window.document.querySelectorAll("[data-notice-id]").length;
	return { notice, sonnerDismissed, fallbackItems };
}

test("Toaster 挂载前弹出的常驻兜底通知，挂载后仍能被关闭", () => {
	const { notice, sonnerDismissed, fallbackItems } = loadNotice();
	const id = notice.showNotice("实时更新连接中断", Number.POSITIVE_INFINITY, "warning");
	assert.equal(fallbackItems(), 1, "挂载前走 DOM 兜底");
	notice.setToasterReady(true);
	notice.dismissNotice(id);
	assert.equal(fallbackItems(), 0, "兜底通知必须被移除，而不是交给 sonner 空操作");
	assert.equal(sonnerDismissed.length, 0);
});

test("Toaster 已挂载时弹出的通知交给 sonner 关闭", () => {
	const { notice, sonnerDismissed, fallbackItems } = loadNotice();
	notice.setToasterReady(true);
	const id = notice.showNotice("实时更新连接中断", Number.POSITIVE_INFINITY, "warning");
	assert.equal(fallbackItems(), 0);
	notice.dismissNotice(id);
	assert.deepEqual([...sonnerDismissed], [id]);
});

test("Toaster 未挂载时关闭兜底通知照常生效", () => {
	const { notice, fallbackItems } = loadNotice();
	const id = notice.showNotice("x", Number.POSITIVE_INFINITY, "info");
	notice.dismissNotice(id);
	assert.equal(fallbackItems(), 0);
	assert.doesNotThrow(() => notice.dismissNotice(undefined));
});
