import { createRequire } from "node:module";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";
import { withComposerReact } from "./composerReactHarness.mjs";

const nodeRequire = createRequire(import.meta.url);
const CONTROLLER_PATH = "src/renderer/src/hooks/useSessionTimelineController.ts";

/**
 * 在真实 React + 真实 jotai store + 真实 session atoms 下挂载 useSessionTimelineController，
 * 只替换主进程边界（desktopApi.sessions）。用于验证「hook 把什么游标交给 atom / IPC」这类
 * 只有挂载后才会触发的接线行为，而不是对源码文本做正则匹配。
 *
 * run 收到：{ atoms, store, calls, mount(sessionId), controller() }。
 * readRecordMessagePage 的应答由 options.respond(call) 决定，所有调用记录在 calls 中。
 *
 * options.timeline(store, atoms) 可选：返回一个假的滚动容器元素，在首次渲染时挽到 timelineRef，
 * 用来观察“历史前置后是否补偿 scrollTop”这类依赖真实滚动容器的行为。
 */
export async function withTimelineController(options, run) {
	await withComposerReact(async (env) => {
		const { React, act, root, window, globals } = env;
		const calls = [];
		const desktopApi = {
			sessions: {
				readRecordMessagePage: (sessionId, before, pageSize, opts) => {
					const call = { sessionId, before, pageSize, opts };
					calls.push(call);
					return options.respond(call);
				},
			},
		};
		const stubs = {
			"../desktopApi": { desktopApi },
			"../i18n": { t: (key) => key },
			"../utils/notice": { showNotice: () => undefined },
		};
		// atoms 单独加载一份并以 stub 形式交给 hook，保证测试与 hook 操作的是同一批 atom 实例。
		const atoms = loadTsCommonJs("src/renderer/src/atoms/index.ts", { stubs });
		const vmGlobals = {
			window,
			document: window.document,
			requestAnimationFrame: globals.requestAnimationFrame,
			cancelAnimationFrame: globals.cancelAnimationFrame,
			CSS: { escape: (value) => String(value) },
		};
		window.setTimeout = setTimeout;
		window.clearTimeout = clearTimeout;
		const controllerModule = loadTsCommonJs(CONTROLLER_PATH, {
			stubs: { ...stubs, "../atoms": atoms },
			globals: vmGlobals,
		});
		const { Provider, createStore } = nodeRequire("jotai");
		const store = createStore();
		let latest;
		function Probe({ sessionId }) {
			latest = controllerModule.useSessionTimelineController({ sessionId });
			// 在 effect 运行前（渲染阶段）挽上假容器，请求补页时 hook 才能读到它的 scrollHeight/scrollTop。
			if (options.timeline && !latest.timelineRef.current) {
				latest.timelineRef.current = options.timeline(store, atoms);
			}
			return null;
		}
		await run({
			atoms,
			store,
			calls,
			controllerModule,
			controller: () => latest,
			act,
			async mount(sessionId) {
				await act(async () => {
					root.render(
						React.createElement(
							Provider,
							{ store },
							React.createElement(Probe, { sessionId }),
						),
					);
				});
				// 让 readRecordMessagePage 的 promise 链与后续 effect 落地。
				await act(async () => {
					await new Promise((resolve) => setTimeout(resolve, 0));
				});
			},
		});
	});
}
