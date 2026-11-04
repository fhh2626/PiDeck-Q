import { createRequire } from "node:module";
import { parseHTML } from "linkedom";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);
// 与 loadTsCommonJs 内的 nodeRequire 取同一份 CJS React / jotai，避免出现双实例（Provider context 不互通）。
const React = nodeRequire("react");
const { act } = React;

/**
 * L5 Hook 宿主：在 linkedom 提供的最小 DOM 上用真实 React 渲染一个探针组件，
 * 让被测 hook 的 state / effect / ref / 清理函数全部真实执行（而不是读源码文本）。
 *
 * - rAF 是手动队列，测试通过 flushFrames() 确定性推进；
 * - 全局量在 finally 中还原，保证用例之间互不污染。
 */
export async function withHookHost(run) {
	const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
	window.location = { protocol: "http:", href: "http://localhost/" };
	let nextFrame = 0;
	const frames = new Map();
	const requestAnimationFrame = (fn) => {
		const id = ++nextFrame;
		frames.set(id, fn);
		return id;
	};
	const cancelAnimationFrame = (id) => {
		frames.delete(id);
	};
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Event: window.Event,
		IS_REACT_ACT_ENVIRONMENT: true,
		requestAnimationFrame,
		cancelAnimationFrame,
	};
	const previous = new Map(
		Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	let root;
	try {
		for (const [key, value] of Object.entries(globals)) {
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
		const { createRoot } = await import("react-dom/client");
		root = createRoot(window.document.getElementById("root"));

		/** 渲染 useHook(props)；wrap 可包一层 Provider。result() 永远返回最近一次渲染的返回值。 */
		async function mount(useHook, props, wrap = (node) => node) {
			let latest;
			let renders = 0;
			function Probe({ hookProps }) {
				latest = useHook(hookProps);
				renders++;
				return null;
			}
			const tree = (hookProps) => wrap(React.createElement(Probe, { hookProps }));
			await act(async () => {
				root.render(tree(props));
			});
			return {
				result: () => latest,
				renders: () => renders,
				async rerender(nextProps) {
					await act(async () => {
						root.render(tree(nextProps));
					});
				},
				async unmount() {
					await act(async () => {
						root.render(null);
					});
				},
			};
		}

		await run({
			React,
			act,
			window,
			mount,
			globals,
			/** 在宿主 DOM 全局量下加载生产 TS 模块（vm 上下文不继承 globalThis 的 document/rAF）。 */
			load: (filePath, options = {}) =>
				loadTsCommonJs(filePath, {
					...options,
					globals: { ...globals, ...options.globals },
				}),
			flushFrames: async () => {
				await act(async () => {
					const pending = [...frames.values()];
					frames.clear();
					for (const fn of pending) fn(0);
				});
			},
			pendingFrames: () => frames.size,
		});
	} finally {
		if (root) await act(async () => root.unmount());
		frames.clear();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globalThis[key];
		}
	}
}
