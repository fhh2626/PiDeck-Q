import React, { act } from "react";
import { parseHTML } from "linkedom";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/**
 * FileDiff 行为测试的 React 宿主：真实挂载生产组件（生命周期、effect、JSX 条件都执行），
 * 只替身化图标 / motion / AgentDisclosure 与高亮钩子，避免测试依赖 Shiki 与动画实现。
 *
 * AgentDisclosure 的替身刻意保留「收起时子节点仍挂载」这一真实行为：
 * 这样「收起时看不到正文」只可能由 FileDiff 自己的挂载门决定，测试才有意义。
 */
export async function withFileDiffReact(run) {
	const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
	// linkedom 不提供 location；motion/react 在真实挂载时会读 protocol。
	window.location = { protocol: "http:", href: "http://localhost/" };
	let nextFrame = 0;
	const frames = new Map();
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Event: window.Event,
		MouseEvent: window.MouseEvent,
		IS_REACT_ACT_ENVIRONMENT: true,
		requestAnimationFrame: (fn) => {
			const id = ++nextFrame;
			frames.set(id, fn);
			return id;
		},
		cancelAnimationFrame: (id) => {
			frames.delete(id);
		},
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

		const click = async (element) => {
			await act(() => {
				// linkedom 不保证暴露 MouseEvent 构造器；click 只需冒泡的普通事件即可命中 React 监听。
				element.dispatchEvent(new window.Event("click", { bubbles: true }));
			});
		};

		await run({
			React,
			act,
			root,
			window,
			click,
			loadFileDiff: (stubs) =>
				loadTsCommonJs("src/renderer/src/components/agents/file-diff.tsx", {
					stubs: { ...diffStubs(), ...stubs },
					// vm 上下文不会自带浏览器全局量：组件的 layout effect 需要 rAF。
					globals: {
						window,
						document: window.document,
						navigator: window.navigator,
						HTMLElement: window.HTMLElement,
						requestAnimationFrame: globals.requestAnimationFrame,
						cancelAnimationFrame: globals.cancelAnimationFrame,
					},
				}),
			/** 正文容器数量：0 表示正文未挂载。 */
			bodyCount: () => window.document.querySelectorAll('[data-slot="file-diff-viewport"]').length,
			trigger: () => window.document.querySelector("button[aria-expanded]"),
		});
	} finally {
		if (root) await act(() => root.unmount());
		frames.clear();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globalThis[key];
		}
	}
}

/** 除 react 外的依赖全部替身化：图标、动画、共享折叠容器、高亮钩子。 */
function diffStubs() {
	const inert = (props) => props.children ?? null;
	return {
		"lucide-react": new Proxy({}, { get: () => (props) => React.createElement("i", props) }),
		"motion/react": {
			motion: new Proxy({}, { get: () => (props) => React.createElement("span", props) }),
			useReducedMotion: () => false,
		},
		"@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
		"@/lib/ease": { SPRING_PRESS: {}, SPRING_SWAP: {} },
		// 真实 AgentDisclosure 收起时用 height:0 隐藏但保留子节点；替身保持同一挂载语义。
		"@/components/agents/agent-disclosure": { AgentDisclosure: inert },
		"./agent-disclosure": { AgentDisclosure: inert },
		"@/components/agents/agent-code": {
			AgentCodeLine: (props) => React.createElement("span", null, props.code),
			useAgentCodeTokens: () => null,
		},
		"./agent-code": {
			AgentCodeLine: (props) => React.createElement("span", null, props.code),
			useAgentCodeTokens: () => null,
		},
	};
}
