import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { requestWithFallback } from "../src/native-node/host/requestWithFallback.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 回归：刷新后永久停在“正在启动工作台”。
 * 成因：bootstrap 失败/挂起时遮罩无人撤掉也无错误提示；bootstrap 依赖一个没有超时的宿主剪贴板请求；
 * 错误边界与“清理缓存”按钮用裸 window.location.reload() 丢掉了已被抹除的 token。
 */

const read = (path) => readFileSync(path, "utf8");

test("requestWithFallback：正常返回时不降级", async () => {
	const result = await requestWithFallback(async () => "live", "fallback", 200);
	assert.deepEqual(result, { value: "live", degraded: false });
});

test("requestWithFallback：宿主请求永不返回时按超时降级，而不是无限等待", async () => {
	const startedAt = Date.now();
	const result = await requestWithFallback(() => new Promise(() => {}), "fallback", 50);
	assert.deepEqual(result, { value: "fallback", degraded: true });
	assert.ok(Date.now() - startedAt < 1_000);
});

test("requestWithFallback：宿主请求失败时降级，且迟到的拒绝不会产生未处理拒绝", async () => {
	let rejectLate;
	const late = new Promise((_, reject) => {
		rejectLate = reject;
	});
	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const result = await requestWithFallback(() => late, "fallback", 20);
		assert.equal(result.degraded, true);
		rejectLate(new Error("late failure"));
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

function createFakeDom() {
	const makeElement = (tag = "div") => ({
		tag,
		className: "",
		textContent: "",
		type: "",
		dataset: {},
		children: [],
		listeners: {},
		appendChild(child) {
			this.children.push(child);
		},
		addEventListener(name, listener) {
			this.listeners[name] = listener;
		},
		querySelector(selector) {
			return this.selectors?.[selector] ?? null;
		},
	});
	const subtitle = makeElement("span");
	const brand = makeElement("div");
	const overlay = makeElement("div");
	overlay.selectors = { ".boot-subtitle": subtitle, ".boot-brand": brand };
	return {
		overlay,
		subtitle,
		brand,
		document: {
			getElementById: (id) => (id === "boot-overlay" ? overlay : null),
			createElement: (tag) => makeElement(tag),
		},
	};
}

function loadBootFailure({ search, token, reloads }) {
	const dom = createFakeDom();
	const module = loadTsCommonJs("src/renderer/src/bootFailure.ts", {
		stubs: {
			"./i18n": { t: (key) => key },
			"./native/initializeNativeDesktop": {
				getNativeRendererToken: () => token,
				reloadDesktopRenderer: () => reloads.push("reload"),
			},
		},
		globals: {
			document: dom.document,
			window: { location: { search } },
		},
	});
	return { ...dom, showBootFailure: module.showBootFailure };
}

test("启动失败时遮罩显示失败标题、原因和重试按钮，点击重试走带 token 的重载", () => {
	const reloads = [];
	const dom = loadBootFailure({ search: "?runtime=native", token: "tok", reloads });
	dom.showBootFailure(new Error("Native bootstrap failed (401)"));
	assert.equal(dom.overlay.dataset.failed, "true");
	assert.equal(dom.subtitle.textContent, "app.bootFailedTitle");
	const [detail, retry] = dom.brand.children;
	assert.equal(detail.textContent, "Native bootstrap failed (401)");
	assert.equal(retry.textContent, "app.bootFailedRetry");
	retry.listeners.click();
	assert.deepEqual(reloads, ["reload"]);
});

test("原生运行时已丢失 token 时不提供会失败的重试按钮，而是提示按 F5", () => {
	const dom = loadBootFailure({ search: "?runtime=native", token: null, reloads: [] });
	dom.showBootFailure(new Error("Native runtime token is missing"));
	const texts = dom.brand.children.map((child) => child.textContent);
	assert.ok(texts.includes("app.bootFailedPressRefresh"));
	assert.ok(!dom.brand.children.some((child) => child.className === "boot-retry"));
});

test("showBootFailure 是幂等的，且错误详情会被截断", () => {
	const dom = loadBootFailure({ search: "", token: null, reloads: [] });
	dom.showBootFailure(new Error("x".repeat(1_000)));
	dom.showBootFailure(new Error("second"));
	assert.equal(dom.brand.children.length, 2);
	assert.equal(dom.brand.children[0].textContent.length, 240);
});

test("主入口在 bootstrap 失败时调用 showBootFailure，不再让遮罩永久挂着", () => {
	const main = read("src/renderer/src/main.tsx");
	assert.match(main, /showBootFailure\(error\);/);
	assert.match(main, /import \{ showBootFailure \} from "\.\/bootFailure";/);
});

test("错误边界与清理缓存按钮不再用裸 location.reload()，改走保留 token 的重载", () => {
	for (const path of [
		"src/renderer/src/components/app/AppErrorBoundary.tsx",
		"src/renderer/src/components/app/settings/SettingsStorageTab.tsx",
	]) {
		const source = read(path);
		assert.doesNotMatch(source, /window\.location\.reload\(\)/, path);
		assert.match(source, /reloadDesktopRenderer\(\)/, path);
	}
	const bootstrap = read("src/renderer/src/native/initializeNativeDesktop.ts");
	assert.match(bootstrap, /export function reloadDesktopRenderer\(\): void \{\s*if \(nativeRendererToken\) \{\s*reloadNativeRenderer\(nativeRendererToken\);/);
});

// bootstrap 超时与就绪失败后重连的行为测试见 initializeNativeDesktopBoot.test.mjs。

test("失败页样式不被 #boot-overlay * 的 reset 覆盖（选择器特异性必须不低于 reset）", () => {
	const html = read("src/renderer/index.html");
	// reset 规则 "#boot-overlay *" 特异性 (1,0,0)；单类选择器会丢掉 margin/padding。
	assert.match(html, /#boot-overlay, #boot-overlay \* \{ margin: 0; padding: 0;/);
	for (const className of ["boot-detail", "boot-retry"]) {
		const bare = new RegExp(String.raw`^\s*\.${className}(:hover)?\s*\{`, "m");
		assert.doesNotMatch(html, bare, `.${className} 必须带 #boot-overlay 前缀`);
		assert.match(html, new RegExp(String.raw`#boot-overlay \.${className}\s*\{`));
	}
});

test("启动失败后 logo 循环动画停止并定格为完整 logo", () => {
	const logo = read("src/renderer/src/boot-logo.ts");
	assert.match(logo, /overlay\?\.dataset\.failed !== "true"/);
	assert.match(logo, /if \(overlay\.isConnected && overlay\.dataset\.failed === "true"\) \{\s*paintCells\(canvas, finalLogoCells\(settledLogoColor\(\)\), size\);/);
});

test("Sidecar 的 bootstrap 不依赖无超时的宿主剪贴板请求", () => {
	const index = read("src/native-node/index.ts");
	assert.match(index, /requestWithFallback<NativeClipboardMetadata>\(/);
	assert.match(index, /BOOTSTRAP_CLIPBOARD_TIMEOUT_MS/);
	assert.doesNotMatch(index, /const clipboard = await host\.request<NativeClipboardMetadata>\("clipboard\.metadataSnapshot"\);\s*const externalFileCapabilityId = issueClipboardCapability\(clipboard\);\s*return \{/);
});
