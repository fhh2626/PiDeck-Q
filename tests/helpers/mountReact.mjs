import React, { act } from "react";
import { parseHTML } from "linkedom";

/**
 * Mount one production component in linkedom.
 * Callers load the component with loadTsCommonJs so JSX and hooks actually run.
 */
export async function mountReact(render) {
	const { window } = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	window.location = { protocol: "http:", href: "http://localhost/" };
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		KeyboardEvent: window.KeyboardEvent,
		MouseEvent: window.MouseEvent,
		IS_REACT_ACT_ENVIRONMENT: true,
		requestAnimationFrame: (fn) => {
			fn(0);
			return 1;
		},
		cancelAnimationFrame: () => {},
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
				element.dispatchEvent(new window.Event("click", { bubbles: true }));
			});
		};
		await render({ React, act, root, window, document: window.document, click });
	} finally {
		if (root) await act(() => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globalThis[key];
		}
	}
}
