import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

// 锁底滚动引擎（useStickToBottom）的“逃逸 / 重锁”语义。
// 真实挂载 hook，用假的滚动容器 + 假的 ResizeObserver + 可控时钟驱动 scroll / wheel / 内容增长事件，
// 断言对外可观察的 state.isAtBottom / state.escapedFromLock / scrollTop。
//
// 几何：scrollHeight=2000, clientHeight=500 → 底部 scrollTop=1500（距底 0）；
// 引擎的 targetScrollTop = scrollHeight - 1 - clientHeight = 1499。

const BOTTOM = 1500;
// withHookHost 会在测试期间把全局 Event 换成 linkedom 版本；EventTarget 只认 Node 原生 Event，故先捕获。
const NodeEvent = globalThis.Event;

/** 最小可滚动元素：EventTarget + 可写 scrollTop（不做浏览器 clamp，测试自己控制位置）。 */
class FakeScrollElement extends EventTarget {
	constructor() {
		super();
		this.scrollTop = BOTTOM;
		this.scrollHeight = 2000;
		this.clientHeight = 500;
		this.parentElement = null;
	}
}

class FakeContentElement {}

function createEngineEnv() {
	const clock = { now: 10_000 };
	const observers = [];
	class FakeResizeObserver {
		constructor(callback) {
			this.callback = callback;
			observers.push(this);
		}
		observe() {}
		disconnect() {}
	}
	const frames = [];
	// 引擎用 setTimeout(…, 1) 延迟判定“用户是否逃逸”。换成可手动推进的假定时器：真实定时器在机器繁忙时
	// 会让“没有发生逃逸”这类用例在判定尚未执行时误绿，也会让“逃逸”类用例偶发变红。
	const timers = [];
	const globals = {
		setTimeout: (fn) => {
			timers.push(fn);
			return timers.length;
		},
		clearTimeout: () => undefined,
		performance: { now: () => clock.now },
		ResizeObserver: FakeResizeObserver,
		getComputedStyle: () => ({ overflow: "auto" }),
		requestAnimationFrame: (fn) => {
			frames.push(fn);
			return frames.length;
		},
		cancelAnimationFrame: () => undefined,
	};
	const { useStickToBottom } = loadTsCommonJs(
		"src/renderer/src/lib/stick-to-bottom/useStickToBottom.ts",
		{ globals },
	);
	/** 执行当前所有待处理的定时器（含执行中新登记的），有上限避免死循环。 */
	const runTimers = () => {
		for (let guard = 0; timers.length > 0 && guard < 100; guard += 1) timers.shift()();
		assert.equal(timers.length, 0, "engine timers must settle within the bounded drain");
	};
	return { useStickToBottom, clock, observers, runTimers };
}

/** 挂载引擎并接上假的滚动容器/内容容器；返回驱动用户行为的小工具。 */
async function mountEngine(host, options = { initial: "instant", resize: "instant" }) {
	const env = createEngineEnv();
	const mounted = await host.mount(env.useStickToBottom, options);
	const scroll = new FakeScrollElement();
	const content = new FakeContentElement();
	await host.act(async () => {
		mounted.result().scrollRef(scroll);
		mounted.result().contentRef(content);
	});
	const state = mounted.result().state;
	const settle = () => host.act(async () => env.runTimers());

	const driver = {
		state,
		scroll,
		clock: env.clock,
		/** 用户把滚动条拖到 top：触发 scroll 事件并等待引擎的 1ms 延迟判定。 */
		async scrollTo(top) {
			scroll.scrollTop = top;
			await host.act(async () => scroll.dispatchEvent(new NodeEvent("scroll")));
			await settle();
		},
		/** 滚轮：deltaY<0 为上滚。 */
		async wheel(deltaY) {
			await host.act(async () => {
				const event = new NodeEvent("wheel");
				event.deltaY = deltaY;
				scroll.dispatchEvent(event);
			});
		},
		/** 内容高度变化（ResizeObserver 回调）。 */
		async resizeTo(height) {
			await host.act(async () => env.observers.at(-1).callback([{ contentRect: { height } }]));
			await settle();
		},
	};
	// 先建立 lastScrollTop 基线（贴底），之后的 scroll 才有方向。
	await driver.scrollTo(BOTTOM);
	return driver;
}

// ── 用户明确上滚立即逃逸进入阅读状态（不再受旧 25px 容差或 200px 增长保护带压制）──

test("scrolling up even by a small distance escapes the bottom lock immediately", async () => {
	await withHookHost(async (host) => {
		const engine = await mountEngine(host);
		await engine.scrollTo(BOTTOM - 20);
		assert.equal(engine.state.escapedFromLock, true, "明确上滚 20px 必须立即进入阅读模式");
		assert.equal(engine.state.isAtBottom, false);
	});
});

test("scrolling up beyond the 25px tolerance band escapes the bottom lock", async () => {
	await withHookHost(async (host) => {
		const engine = await mountEngine(host);
		await engine.scrollTo(BOTTOM - 100);
		assert.equal(engine.state.escapedFromLock, true);
		assert.equal(engine.state.isAtBottom, false);
	});
});

test("wheel-up near the bottom escapes immediately when content is vertically scrollable", async () => {
	await withHookHost(async (host) => {
		const engine = await mountEngine(host);
		engine.scroll.scrollTop = BOTTOM - 10;
		await engine.wheel(-50);
		assert.equal(engine.state.escapedFromLock, true, "真实滚轮上滚必须立即打断追底并逃逸");
		assert.equal(engine.state.isAtBottom, false);
	});
});

test("wheel-up beyond the tolerance band escapes the bottom lock", async () => {
	await withHookHost(async (host) => {
		const engine = await mountEngine(host);
		engine.scroll.scrollTop = BOTTOM - 100;
		await engine.wheel(-50);
		assert.equal(engine.state.escapedFromLock, true);
		assert.equal(engine.state.isAtBottom, false);
	});
});

test("wheel-down never escapes the bottom lock", async () => {
	await withHookHost(async (host) => {
		const engine = await mountEngine(host);
		engine.scroll.scrollTop = BOTTOM - 100;
		await engine.wheel(50);
		assert.equal(engine.state.escapedFromLock, false);
	});
});

// ── 流式增长时用户意图优先：即使在流式增长窗口内，上滚也立即逃逸 ──

test("scroll-up right after streaming growth escapes immediately into reader mode", async () => {
	await withHookHost(async (host) => {
		const engine = await mountEngine(host);
		await engine.resizeTo(1000); // 建立内容高度基线并刷新“最近正增长”时刻
		engine.clock.now += 100; // 仍在流式紧密间隔内
		await engine.scrollTo(BOTTOM - 100); // 用户主动上滚
		assert.equal(engine.state.escapedFromLock, true, "即使刚刚发生正增长，上滚也必须立即逃逸");
		assert.equal(engine.state.isAtBottom, false);
	});
});

test("scroll-up beyond the guard band escapes immediately even while streaming", async () => {
	await withHookHost(async (host) => {
		const engine = await mountEngine(host);
		await engine.resizeTo(1000);
		engine.clock.now += 100;
		await engine.scrollTo(BOTTOM - 300); // 距底 300px > 200px：明确要读历史
		assert.equal(engine.state.escapedFromLock, true);
		assert.equal(engine.state.isAtBottom, false);
	});
});

test("the growth guard expires 500ms after the last positive growth", async () => {
	await withHookHost(async (host) => {
		const engine = await mountEngine(host);
		await engine.resizeTo(1000);
		engine.clock.now += 600; // 流式已结束超过 500ms：恢复正常逃逸语义
		await engine.scrollTo(BOTTOM - 100);
		assert.equal(engine.state.escapedFromLock, true);
		assert.equal(engine.state.isAtBottom, false);
	});
});

test("wheel-up escapes immediately even right after positive resize", async () => {
	await withHookHost(async (host) => {
		const engine = await mountEngine(host);
		await engine.resizeTo(1000);
		engine.clock.now += 100;
		engine.scroll.scrollTop = BOTTOM - 100;
		await engine.wheel(-50);
		assert.equal(engine.state.escapedFromLock, true, "正增长后紧接着滚轮上滚必须立即逃逸");
		assert.equal(engine.state.isAtBottom, false);

		engine.scroll.scrollTop = BOTTOM - 300;
		await engine.wheel(-50);
		assert.equal(engine.state.escapedFromLock, true);
	});
});

test("user scroll-up escapes immediately across multiple positive growths", async () => {
	await withHookHost(async (host) => {
		const engine = await mountEngine(host);
		await engine.resizeTo(1000);
		engine.clock.now += 400;
		await engine.resizeTo(1100); // 再次正增长
		engine.clock.now += 400;
		await engine.scrollTo(BOTTOM - 100);
		assert.equal(engine.state.escapedFromLock, true, "正增长多次后用户上滚依然立即逃逸");
		assert.equal(engine.state.isAtBottom, false);
	});
});

// ── 逃逸后不被内容增长拽回 ──

test("an escaped reader near the bottom is never dragged back by content growth", async () => {
	await withHookHost(async (host) => {
		const engine = await mountEngine(host);
		await engine.resizeTo(1000);
		engine.clock.now += 1000; // 越过守卫窗口，使上滚真正逃逸
		await engine.scrollTo(BOTTOM - 50); // 距底 50px：已逃逸，但仍在 70px 近底带内
		assert.equal(engine.state.escapedFromLock, true);
		assert.equal(engine.state.isNearBottom, true);

		const readingPosition = engine.scroll.scrollTop;
		await engine.resizeTo(1200); // 输出完成后的尾部正增长
		assert.equal(engine.state.escapedFromLock, true, "增长不得自动清除逃逸");
		assert.equal(engine.state.isAtBottom, false, "增长不得自动恢复锁底");
		assert.equal(engine.scroll.scrollTop, readingPosition, "不得把阅读位置拽回底部");
	});
});

test("content growth while attached keeps following the bottom", async () => {
	await withHookHost(async (host) => {
		const engine = await mountEngine(host);
		engine.scroll.scrollTop = BOTTOM - 400;
		engine.scroll.scrollHeight = 2400; // 内容变高，目标位置下移
		await engine.resizeTo(1000);
		await engine.resizeTo(1100);
		assert.equal(engine.state.isAtBottom, true);
		assert.equal(engine.scroll.scrollTop, 2400 - 1 - 500, "锁底时增长应把 scrollTop 贴到新的底部");
	});
});

// ── 重锁语义 ──

test("scrolling back down into the near-bottom band re-locks after an escape", async () => {
	await withHookHost(async (host) => {
		const engine = await mountEngine(host);
		await engine.scrollTo(BOTTOM - 200);
		assert.equal(engine.state.isAtBottom, false);
		await engine.scrollTo(BOTTOM - 10); // 向下滚回实时尾部（近底 70px 带）
		assert.equal(engine.state.escapedFromLock, false);
		assert.equal(engine.state.isAtBottom, true);
	});
});

test("scrolling down but staying far from the bottom clears the escape flag without re-locking", async () => {
	await withHookHost(async (host) => {
		const engine = await mountEngine(host);
		await engine.scrollTo(BOTTOM - 1000);
		assert.equal(engine.state.escapedFromLock, true);
		await engine.scrollTo(BOTTOM - 800); // 下滚，但仍远离近底带
		assert.equal(engine.state.escapedFromLock, false);
		assert.equal(engine.state.isAtBottom, false);
	});
});

test("content shrinking re-locks a user who never escaped but is near the bottom", async () => {
	await withHookHost(async (host) => {
		const engine = await mountEngine(host);
		// 下滚到远处：未逃逸（escaped=false）但也不在底部
		await engine.scrollTo(BOTTOM - 1000);
		await engine.scrollTo(BOTTOM - 800);
		assert.equal(engine.state.escapedFromLock, false);
		assert.equal(engine.state.isAtBottom, false);

		await engine.resizeTo(1000);
		engine.scroll.scrollTop = BOTTOM - 20; // 内容收缩使容器恰好落在底部附近
		await engine.resizeTo(900); // 负增长
		assert.equal(engine.state.isAtBottom, true);
	});
});

test("content shrinking never re-locks a reader who escaped upward", async () => {
	await withHookHost(async (host) => {
		const engine = await mountEngine(host);
		await engine.scrollTo(BOTTOM - 100);
		assert.equal(engine.state.escapedFromLock, true);

		await engine.resizeTo(1000);
		engine.scroll.scrollTop = BOTTOM - 20; // 距底 <70px，但用户已主动上滚逃逸
		await engine.resizeTo(900); // 负增长（折叠内外高度往返的其中一帧）
		assert.equal(engine.state.escapedFromLock, true);
		assert.equal(engine.state.isAtBottom, false, "负增长帧不得把读历史的用户误重锁");
	});
});
