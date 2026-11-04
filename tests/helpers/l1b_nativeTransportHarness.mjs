import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/**
 * 在沙箱里加载真实的 NativeDesktopTransport，把 fetch / EventSource / 定时器换成可控替身。
 * 定时器永不真正触发（由测试用 fireTimer 手动推进），因此不会挂住事件循环。
 */
export function loadNativeTransport() {
	const timers = [];
	const fetchCalls = [];
	const eventSources = [];
	let fetchImpl = async () => {
		throw new Error("fetch not configured");
	};

	class FakeEventSource {
		constructor(url) {
			this.url = String(url);
			this.readyState = 1;
			this.closed = false;
			eventSources.push(this);
		}
		close() {
			this.closed = true;
			this.readyState = 2;
		}
	}

	const fakeSetTimeout = (fn, ms) => {
		const timer = { fn, ms, cleared: false, fired: false };
		timers.push(timer);
		return timer;
	};
	const fakeClearTimeout = (timer) => {
		if (timer) timer.cleared = true;
	};

	// 路径别名 @shared 只在打包器里有效；沙箱里用真实的 nativeLimits 模块顶替。
	const nativeLimits = loadTsCommonJs("src/shared/desktop/nativeLimits.ts");
	const exports = loadTsCommonJs("src/renderer/src/native/NativeDesktopTransport.ts", {
		stubs: { "@shared/desktop/nativeLimits": nativeLimits },
		globals: {
			fetch: (url, init) => {
				fetchCalls.push({ url: String(url), init });
				return fetchImpl(url, init);
			},
			EventSource: FakeEventSource,
			setTimeout: fakeSetTimeout,
			clearTimeout: fakeClearTimeout,
		},
	});
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

	return {
		...exports,
		ipcChannels,
		timers,
		fetchCalls,
		eventSources,
		setFetch: (impl) => {
			fetchImpl = impl;
		},
		/** 触发尚未清除/触发的定时器（模拟时间流逝）。 */
		fireTimer(timer) {
			assert(!timer.cleared && !timer.fired, "timer must still be pending");
			timer.fired = true;
			timer.fn();
		},
		/** 返回指定延迟、仍处于挂起状态的定时器。 */
		pendingTimers: (ms) => timers.filter((t) => t.ms === ms && !t.cleared && !t.fired),
	};
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

/** 一个只会在 signal 被 abort 时才 reject 的 fetch，用来模拟无响应的服务端。 */
export function hangingFetch() {
	return (_url, init) =>
		new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => {
				const error = new Error("The operation was aborted");
				error.name = "AbortError";
				reject(error);
			});
		});
}

export function okJsonResponse(result) {
	return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
}