import { createRequire } from "node:module";
import { withHookHost } from "./l5_hookHost.mjs";

const require = createRequire(import.meta.url);

/** Real React and CodeMirror in a DOM without layout. No caret geometry or paint timing is claimed. */
export async function withFileEditorDom(run) {
	const observerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "MutationObserver");
	try {
		await withHookHost(async (host) => {
			Object.defineProperty(globalThis, "MutationObserver", {
				configurable: true, writable: true, value: host.window.MutationObserver,
			});
			// linkedom has no OS focus/selection. Transactions still use the real CM state,
			// while the hook host leaves layout measurements in its controlled rAF queue.
			host.window.document.getSelection = () => null;
			host.window.document.hasFocus = () => false;
			const { EditorView } = require("@codemirror/view");
			const setup = host.load("src/renderer/src/utils/codemirrorSetup.ts");
			const passthrough = ({ children }) => children ?? null;
			const menu = Object.fromEntries(["DropdownMenu", "DropdownMenuContent", "DropdownMenuItem", "DropdownMenuTrigger"].map((key) => [key, passthrough]));
			const loadEditor = (loadLanguage = setup.loadEditorLanguage) => host.load(
				"src/renderer/src/components/app/CodeMirrorEditor.tsx", {
					stubs: {
						"../../utils/codemirrorSetup": { ...setup, loadEditorLanguage: loadLanguage },
						"../../i18n": { t: (key) => key },
						"../ui-shadcn/dropdown-menu": menu,
					},
				},
			).CodeMirrorEditor;
			async function mountComponent(Component, props) {
				let current = props;
				const mounted = await host.mount(() => null, null, () => host.React.createElement(Component, current));
				return {
					async rerender(next) { current = next; await mounted.rerender(null); },
					unmount: mounted.unmount,
				};
			}
			const view = () => {
				const element = host.window.document.querySelector(".cm-editor");
				return element ? EditorView.findFromDOM(element) : null;
			};
			await run({ ...host, loadEditor, mountComponent, view, require });
		});
	} finally {
		if (observerDescriptor) Object.defineProperty(globalThis, "MutationObserver", observerDescriptor);
		else delete globalThis.MutationObserver;
	}
}

/** A gate exposes dependency completion without wall-clock sleeps. */
export function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}
