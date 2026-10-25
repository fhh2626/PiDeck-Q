import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

// Session-first 只改变 runtime 何时启动，不改变主 dev 工作台侧栏的默认宽度（221）。
// 通过 useResize 的公开行为断言：首次启动（无持久化值）是 221；折叠后再展开恢复用户拖过的宽度。
const loadResize = (host) => host.load("src/renderer/src/hooks/useResize.ts");

function memoryStorage(initial = {}) {
	const values = new Map(Object.entries(initial));
	return {
		getItem: (key) => (values.has(key) ? values.get(key) : null),
		setItem: (key, value) => void values.set(key, String(value)),
	};
}

test("first launch without a persisted value starts the sidebar at 221px", async () => {
	await withHookHost(async (host) => {
		const { useResize } = loadResize(host);
		const mounted = await host.mount(useResize, { storage: memoryStorage() });
		assert.equal(mounted.result().listWidth, 221);
		assert.equal(mounted.result().DEFAULT_LIST_WIDTH, 221);
	});
});

test("readListWidth falls back to 221px when storage is missing or corrupt", async () => {
	const { readListWidth, LIST_WIDTH_STORAGE_KEY } = loadTsCommonJs("src/renderer/src/hooks/useResize.ts");
	assert.equal(readListWidth(undefined), 221);
	assert.equal(readListWidth(memoryStorage({ [LIST_WIDTH_STORAGE_KEY]: "not-a-number" })), 221);
	assert.equal(
		readListWidth({
			getItem() {
				throw new Error("storage unavailable");
			},
		}),
		221,
	);
});

test("re-expanding a collapsed sidebar restores the width the user had, and keeps it persisted", async () => {
	await withHookHost(async (host) => {
		const { useResize, LIST_WIDTH_STORAGE_KEY } = loadResize(host);
		const storage = memoryStorage({ [LIST_WIDTH_STORAGE_KEY]: "300" });
		const mounted = await host.mount(useResize, { storage });
		assert.equal(mounted.result().listWidth, 300);
		await host.act(async () => mounted.result().toggleListCollapsed());
		assert.equal(mounted.result().listCollapsed, true);
		await host.act(async () => mounted.result().toggleListCollapsed());
		assert.equal(mounted.result().listCollapsed, false);
		assert.equal(mounted.result().listWidth, 300, "the dragged width survives a collapse/expand round trip");
		assert.equal(storage.getItem(LIST_WIDTH_STORAGE_KEY), "300", "re-expanding must not overwrite the saved width");
	});
});

test("a width dragged in this session is what comes back after collapse and expand", async () => {
	await withHookHost(async (host) => {
		const { useResize } = loadResize(host);
		const mounted = await host.mount(useResize, { storage: memoryStorage() });
		await host.act(async () => mounted.result().setListWidth(260));
		await host.act(async () => mounted.result().toggleListCollapsed());
		await host.act(async () => mounted.result().toggleListCollapsed());
		assert.equal(mounted.result().listWidth, 260);
	});
});

test("collapsing and re-expanding without ever resizing keeps the 221px default", async () => {
	await withHookHost(async (host) => {
		const { useResize } = loadResize(host);
		const mounted = await host.mount(useResize, { storage: memoryStorage() });
		await host.act(async () => mounted.result().toggleListCollapsed());
		await host.act(async () => mounted.result().toggleListCollapsed());
		assert.equal(mounted.result().listWidth, 221);
	});
});

test("a width below the draggable minimum is replaced by the default on re-expand", async () => {
	// 折叠态不会回写宽度，但万一 state 里是不可拖拽的极小值（例如外部 setListWidth(0)），展开后不能卡在 0。
	await withHookHost(async (host) => {
		const { useResize } = loadResize(host);
		const mounted = await host.mount(useResize, { storage: memoryStorage() });
		await host.act(async () => mounted.result().setListWidth(0));
		await host.act(async () => mounted.result().toggleListCollapsed());
		await host.act(async () => mounted.result().toggleListCollapsed());
		assert.equal(mounted.result().listWidth, 221);
	});
});

test("a toggle callback captured earlier still sees the latest collapsed state and width", async () => {
	// 快捷键 / 原生菜单这类长寿命回调只会拿到某一次渲染的 toggleListCollapsed；
	// 它必须读最新状态，否则第二次调用仍按“当前未折叠”处理，永远无法展开。
	await withHookHost(async (host) => {
		const { useResize } = loadResize(host);
		const mounted = await host.mount(useResize, { storage: memoryStorage() });
		const capturedToggle = mounted.result().toggleListCollapsed;
		await host.act(async () => capturedToggle());
		assert.equal(mounted.result().listCollapsed, true);
		await host.act(async () => capturedToggle());
		assert.equal(mounted.result().listCollapsed, false, "the same captured callback can expand again");
	});
});

test("two toggles in one event turn restore the expanded state", async () => {
	await withHookHost(async (host) => {
		const { useResize } = loadResize(host);
		const mounted = await host.mount(useResize, { storage: memoryStorage() });
		const toggle = mounted.result().toggleListCollapsed;
		await host.act(async () => { toggle(); toggle(); });
		assert.equal(mounted.result().listCollapsed, false);
	});
});

test("a captured toggle applies the minimum-width fallback using the latest width", async () => {
	await withHookHost(async (host) => {
		const { useResize } = loadResize(host);
		const mounted = await host.mount(useResize, { storage: memoryStorage() });
		const capturedToggle = mounted.result().toggleListCollapsed;
		await host.act(async () => mounted.result().setListWidth(0));
		await host.act(async () => capturedToggle());
		await host.act(async () => capturedToggle());
		assert.equal(mounted.result().listWidth, 221, "width 0 set after capture must still be repaired on expand");
	});
});
