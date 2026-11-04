import { createRequire } from "node:module";
import { withHookHost } from "./l5_hookHost.mjs";

const nodeRequire = createRequire(import.meta.url);
const { Provider, createStore } = nodeRequire("jotai");

/**
 * 真实挂载 useSessionComposerController：真实 React 生命周期、真实 jotai atoms 与 store；
 * 只替身化桌面 API / i18n / 通知（外部边界）。测试通过 controller 的公开面
 * （editor.* / suggestions.* / delivery.*）驱动，再从 store 与 caretRef 观察结果。
 *
 * seed(store, atoms) 可在挂载前预置 store（草稿、消息缓存等）。
 */
export async function withComposerController(run, options = {}) {
	// native / clipboardSnapshot 用于驱动原生剪贴板粘贴路径（insertPlainText 的唤起点）。
	const { sessionId = "s1", seed, commands = [], native = false, clipboardSnapshot } = options;
	await withHookHost(async (host) => {
		const calls = { sendPrompt: [], notices: [], promoted: [] };
		const desktopApi = {
			sessions: {
				sendPrompt: async (input) => {
					calls.sendPrompt.push(input);
					return { type: "accepted" };
				},
				listRuntimeCommands: async () => ({ ok: true, value: commands }),
			},
			files: { list: async () => [] },
			prompts: {
				list: async () => ({ templates: [] }),
				listByProject: async () => ({ templates: [] }),
			},
			settings: { get: async () => ({ sendShortcut: "enter-send" }) },
			clipboard: { readNativeSnapshot: async () => clipboardSnapshot },
		};
		const mod = host.load("tests/helpers/l5_composerEntry.js", {
			stubs: {
				"../desktopApi": { desktopApi, isNativeRuntime: native },
				"../i18n": { t: (key) => key, translateI18nDescriptor: (_descriptor, text) => text },
				"../utils/notice": { showNotice: (message) => calls.notices.push(message) },
			},
		});
		const store = createStore();
		const atomModule = mod.atoms;
		if (seed) seed(store, atomModule);

		const wrap = (node) => host.React.createElement(Provider, { store }, node);
		const hookProps = (props) => ({
			sessionId,
			onPromoteSession: (id) => calls.promoted.push(id),
			...props,
		});
		const mounted = await host.mount(
			(props) => mod.useSessionComposerController(props),
			hookProps(),
			wrap,
		);
		const controller = () => mounted.result();

		const keyEvent = (key, extra = {}) => {
			const event = {
				key,
				ctrlKey: false,
				metaKey: false,
				shiftKey: false,
				nativeEvent: { isComposing: false, keyCode: 0 },
				prevented: false,
				preventDefault() {
					event.prevented = true;
				},
				...extra,
			};
			return event;
		};

		await run({
			host,
			calls,
			store,
			atoms: atomModule,
			mounted,
			controller,
			caret: () => controller().editor.caretRef.current,
			storedDraft: (id = sessionId) => store.get(atomModule.sessionDraftByIdAtom)[id] ?? "",
			rerender: (props) => mounted.rerender(hookProps(props)),
			/** 模拟 TipTap 的“真实键入”：先 onTextInput 再 onChange（与编辑器 handleTextInput→onUpdate 顺序一致）。 */
			async typeChar(char, nextValue, cursor = nextValue.length) {
				await host.act(async () => {
					controller().editor.onTextInput(char);
					controller().editor.onChange(nextValue, cursor);
				});
			},
			/** 编辑器内容变化（无触发符）。 */
			async changeTo(value, cursor = value.length) {
				await host.act(async () => controller().editor.onChange(value, cursor));
			},
			async press(key, extra) {
				const event = keyEvent(key, extra);
				await host.act(async () => controller().editor.onKeyDown(event));
				return event;
			},
		});
	});
}
