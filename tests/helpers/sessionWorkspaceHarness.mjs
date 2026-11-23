import { createRequire } from "node:module";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);
const { Provider, createStore } = nodeRequire("jotai");

/**
 * 真实挂载 useSessionWorkspace（真实 React + jotai store），只替身化：
 * - window.piDesktop.app 的“通知聚焦”三件套（推送订阅 / 拉取 pending / ACK）；
 * - setTimeout（重试队列由测试手动推进，避免真实等待）。
 *
 * @param host withHookHost 提供的宿主
 */
export async function mountSessionWorkspace(host, options = {}, records = {}) {
	const atoms = loadTsCommonJs("src/renderer/src/atoms/index.ts");
	const store = createStore();
	store.set(atoms.sessionRecordsAtom, records);

	// 推送监听、拉取与 ACK 的记录
	const listeners = new Set();
	const acks = [];
	const pulls = [];
	const rejectedPulls = [];
	host.window.piDesktop = {
		app: {
			onFocusSessionTarget: (callback) => {
				listeners.add(callback);
				return () => listeners.delete(callback);
			},
			getPendingFocusTarget: () => new Promise((resolve, reject) => { pulls.push(resolve); rejectedPulls.push(reject); }),
			ackFocusSessionTarget: (id) => {
				acks.push(id);
				return Promise.resolve();
			},
		},
	};

	// 只记录延迟重试，不真正触发
	const timers = [];
	const fakeSetTimeout = (fn, ms) => {
		const timer = { fn, ms, fired: false };
		timers.push(timer);
		return timer;
	};
	const { useSessionWorkspace } = host.load("src/renderer/src/hooks/useSessionWorkspace.ts", {
		stubs: { "../atoms": atoms },
		globals: { setTimeout: fakeSetTimeout, clearTimeout: (timer) => { timer.fired = true; } },
	});
	const wrap = (node) => host.React.createElement(Provider, { store }, node);
	const selectionRequestRef = options.selectionRequestRef ?? { current: 0 };
	const mounted = await host.mount(
		useSessionWorkspace,
		{ currentSessionId: undefined, activeProjectId: undefined, selectionRequestRef, ...options },
		wrap,
	);

	const focusCalls = [];
	const projectFocusCalls = [];
	mounted.result().bindFocusHandlers({
		focusSession: (projectId, sessionId) => focusCalls.push({ projectId, sessionId }),
		focusProject: (projectId) => projectFocusCalls.push(projectId),
	});

	return {
		mounted: {
			...mounted,
			rerender: (props) => mounted.rerender({ selectionRequestRef, ...props }),
		},
		store,
		atoms,
		projectFocusCalls,
		focusCalls,
		acks,
		timers,
		pulls,
		async rejectPull(index, error) {
			await host.act(async () => rejectedPulls[index](error));
		},
		listenerCount: () => listeners.size,
		/** 模拟宿主推送 app:focus-session-target。 */
		async push(target) {
			await host.act(async () => {
				for (const listener of [...listeners]) listener(target);
			});
		},
		/** 完成第 n 次 getPendingFocusTarget 拉取。 */
		async resolvePull(index, target) {
			await host.act(async () => pulls[index](target));
		},
		/** 目录里出现（或更新）会话记录。 */
		async setRecords(records) {
			await host.act(async () => store.set(atoms.sessionRecordsAtom, records));
		},
		/** 触发尚未触发的重试定时器（按注册顺序）。 */
		async fireRetries() {
			await host.act(async () => {
				for (const timer of timers.filter((t) => !t.fired)) {
					timer.fired = true;
					timer.fn();
				}
			});
		},
		pendingRetries: () => timers.filter((t) => !t.fired).length,
	};
}