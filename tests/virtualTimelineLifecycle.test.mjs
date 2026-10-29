import test from "node:test";
import assert from "node:assert/strict";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { ControllableResizeObserver } from "./helpers/controllableResizeObserver.mjs";

test("步骤1回归红测: 同 ID 消息更新后，renderPlan 中的 virtualRow.item 必须是指向最新数据", async () => {
	await withHookHost(async ({ load, mount, window }) => {
		ControllableResizeObserver.reset();
		globalThis.ResizeObserver = ControllableResizeObserver;
		window.ResizeObserver = ControllableResizeObserver;

		const mod = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
			globals: { ResizeObserver: ControllableResizeObserver },
		});
		const { useVirtualTimeline } = mod;

		const viewport = window.document.createElement("div");
		Object.defineProperty(viewport, "scrollTop", { value: 0, writable: true });
		Object.defineProperty(viewport, "clientHeight", { value: 600, writable: true });

		const makeItem = (id, text) => ({
			kind: "message",
			message: { id, role: "user", text, timestamp: 1 },
		});

		let hookResult;
		const probe = await mount(
			(props) => {
				hookResult = useVirtualTimeline({
					items: props.items,
					viewportRef: { current: viewport },
					isFollowing: false,
					applyReaderScrollTop: () => undefined,
					sessionId: "sess-step1",
				});
				return hookResult;
			},
			{ items: [makeItem("msg-1", "old-text")] },
		);

		const firstPlanRow = probe.result().renderPlan.find((e) => e.kind === "row");
		assert.equal(firstPlanRow.row.item.message.text, "old-text");

		// 触发更新：同 ID、同高度估计、新对象和新文本
		await probe.rerender({ items: [makeItem("msg-1", "NEW-UPDATED-TEXT")] });

		const updatedPlanRow = probe.result().renderPlan.find((e) => e.kind === "row");
		assert.equal(
			updatedPlanRow.row.item.message.text,
			"NEW-UPDATED-TEXT",
			"renderPlan 必须反映最新传入的 item 内容，不能保留旧快照！",
		);
	});
});

test("步骤2回归测试: list 与 viewport 宽度不同时，多次初次通知不发生持续 observer 重建与反复循环", async () => {
	await withHookHost(async ({ load, mount, window, flushFrames }) => {
		ControllableResizeObserver.reset();
		globalThis.ResizeObserver = ControllableResizeObserver;
		window.ResizeObserver = ControllableResizeObserver;

		const mod = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
			globals: { ResizeObserver: ControllableResizeObserver },
		});
		const { useVirtualTimeline } = mod;

		const viewport = window.document.createElement("div");
		Object.defineProperty(viewport, "scrollTop", { value: 0, writable: true });
		Object.defineProperty(viewport, "clientHeight", { value: 600, writable: true });

		const list = window.document.createElement("div");

		ControllableResizeObserver.reset();
		let renderCount = 0;
		const probe = await mount(
			() => {
				renderCount++;
				return useVirtualTimeline({
					items: [{ kind: "message", message: { id: "m-1", role: "user", text: "hi", timestamp: 1 } }],
					viewportRef: { current: viewport },
					listRef: { current: list },
					isFollowing: false,
					applyReaderScrollTop: () => undefined,
					sessionId: "sess-step2",
				});
			},
			{},
		);

		// mount 后已经创建了当前测试的 ro 实例
		const currentRo = ControllableResizeObserver.instances[ControllableResizeObserver.instances.length - 1];
		assert.ok(currentRo, "必须创建 ResizeObserver 实例");
		const initialRoCount = ControllableResizeObserver.instances.length;

		// 模拟 viewport (1000px) 和 list (800px) 的合法通知
		currentRo.dispatchEntries([
			ControllableResizeObserver.createEntry(viewport, { width: 1000, height: 600 }),
			ControllableResizeObserver.createEntry(list, { width: 800, height: 180 }),
		]);

		await flushFrames();

		// 再投递一次相同尺寸的通知，验证是否稳定收敛
		currentRo.dispatchEntries([
			ControllableResizeObserver.createEntry(viewport, { width: 1000, height: 600 }),
			ControllableResizeObserver.createEntry(list, { width: 800, height: 180 }),
		]);

		await flushFrames();

		// RO 实例总数不能反复新建
		assert.equal(ControllableResizeObserver.instances.length, initialRoCount, "ResizeObserver 不得持续反复创建！");
	});
});

test("步骤2回归测试: 仅视口高度改变时，即使没有滚动和行高变化，可见范围也要及时更新", async () => {
	await withHookHost(async ({ load, mount, window, act }) => {
		ControllableResizeObserver.reset();
		globalThis.ResizeObserver = ControllableResizeObserver;
		window.ResizeObserver = ControllableResizeObserver;

		const mod = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
			globals: { ResizeObserver: ControllableResizeObserver },
		});
		const { useVirtualTimeline } = mod;

		const viewport = window.document.createElement("div");
		Object.defineProperty(viewport, "scrollTop", { value: 0, writable: true });
		Object.defineProperty(viewport, "clientHeight", { value: 200, writable: true });

		const items = [];
		for (let i = 0; i < 40; i++) {
			items.push({ kind: "message", message: { id: `m-${i}`, role: "user", text: `msg ${i}`, timestamp: i } });
		}

		const probe = await mount(
			() => {
				return useVirtualTimeline({
					items,
					viewportRef: { current: viewport },
					isFollowing: false,
					applyReaderScrollTop: () => undefined,
					sessionId: "sess-step2-height",
				});
			},
			{},
		);

		const initialEnd = probe.result().visibleRange.endIndex;

		// 改变 clientHeight（从 200 扩大到 800，模拟关闭底栏终端）
		Object.defineProperty(viewport, "clientHeight", { value: 800, writable: true });
		const containerRo = ControllableResizeObserver.instances.find((i) => i.observed.has(viewport));
		assert.ok(containerRo, "必须存在观察视口的容器 ResizeObserver");
		await act(() => {
			containerRo.dispatchEntries([ControllableResizeObserver.createEntry(viewport, { width: 1000, height: 800 })]);
		});

		const nextEnd = probe.result().visibleRange.endIndex;
		assert.ok(nextEnd > initialEnd, `视口高度扩大后可见挂载行数必须增加: initial=${initialEnd}, next=${nextEnd}`);
	});
});

test("步骤1回归红测: 首挂真实 ref 注册完成且 effects 执行后，行高实测 900px 必须生效并进入 geometry", async () => {
	await withHookHost(async ({ React, load, mount, window, act, flushFrames }) => {
		ControllableResizeObserver.reset();
		globalThis.ResizeObserver = ControllableResizeObserver;
		window.ResizeObserver = ControllableResizeObserver;

		const mod = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
			globals: { ResizeObserver: ControllableResizeObserver },
		});
		const { useVirtualTimeline } = mod;

		const viewport = window.document.createElement("div");
		Object.defineProperty(viewport, "scrollTop", { value: 0, writable: true });
		Object.defineProperty(viewport, "clientHeight", { value: 600, writable: true });

		const list = window.document.createElement("div");
		const viewportRef = { current: viewport };
		const listRef = { current: list };

		const items = [{ kind: "message", message: { id: "m-1", role: "user", text: "hello", timestamp: 1 } }];
		let hookResult;
		let rowNode;

		const probe = await mount(
			() => {
				hookResult = useVirtualTimeline({
					items,
					viewportRef,
					listRef,
					isFollowing: false,
					applyReaderScrollTop: () => undefined,
					sessionId: "sess-initial-measure",
				});
				return hookResult;
			},
			{},
			(child) =>
				React.createElement(
					React.Fragment,
					null,
					child,
					React.createElement("div", {
						ref: (el) => {
							rowNode = el;
							if (hookResult?.registerRowNode) {
								hookResult.registerRowNode("message:m-1", el);
							}
						},
						"data-timeline-measure-key": "message:m-1",
					}),
				),
		);

		const ro = ControllableResizeObserver.instances.at(-1);
		assert.ok(ro, "必须创建 ResizeObserver 实例");
		assert.ok(rowNode, "行节点必须挂载");

		// 投递 900px 真实测量
		await act(() => {
			ro.dispatchEntries([
				ControllableResizeObserver.createEntry(list, { width: 800, height: 180 }),
				ControllableResizeObserver.createEntry(rowNode, { width: 800, height: 900 }),
			]);
		});
		await flushFrames();

		const geom = probe.result().geometry;
		assert.equal(
			geom.heights[0],
			900,
			`首挂真实节点测量后行高必须为实测值 900px，当前仍为估算值: ${geom.heights[0]}`,
		);
	});
});

test("步骤1回归红测: listRef 初始为 null 时，loading 后挂载的真实列表容器必须进入 observed 集合并使测量生效", async () => {
	await withHookHost(async ({ React, load, mount, window, act, flushFrames }) => {
		ControllableResizeObserver.reset();
		globalThis.ResizeObserver = ControllableResizeObserver;
		window.ResizeObserver = ControllableResizeObserver;

		const mod = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
			globals: { ResizeObserver: ControllableResizeObserver },
		});
		const { useVirtualTimeline } = mod;

		const viewport = window.document.createElement("div");
		Object.defineProperty(viewport, "scrollTop", { value: 0, writable: true });
		Object.defineProperty(viewport, "clientHeight", { value: 600, writable: true });

		// 稳定 ref 对象，初始为 null（模拟 SessionMessageTimeline 的 loading 阶段）
		const listRef = { current: null };
		const viewportRef = { current: viewport };

		const items = [{ kind: "message", message: { id: "m-1", role: "user", text: "hello", timestamp: 1 } }];
		let hookResult;
		let rowNode;
		let triggerLoadFinish;

		function LateListWrapper(props) {
			const [isLoading, setIsLoading] = React.useState(true);
			triggerLoadFinish = () => setIsLoading(false);

			return React.createElement(
				React.Fragment,
				null,
				props.children,
				isLoading
					? React.createElement("div", { className: "loading-placeholder" })
					: React.createElement(
							"div",
							{
								ref: (el) => {
									listRef.current = el;
									if (hookResult?.registerListNode) {
										hookResult.registerListNode(el);
									}
								},
								className: "message-list",
							},
							React.createElement("div", {
								ref: (el) => {
									rowNode = el;
									if (hookResult?.registerRowNode) {
										hookResult.registerRowNode("message:m-1", el);
									}
								},
								"data-timeline-measure-key": "message:m-1",
							}),
					  ),
			);
		}

		const probe = await mount(
			() => {
				hookResult = useVirtualTimeline({
					items,
					viewportRef,
					listRef,
					isFollowing: false,
					applyReaderScrollTop: () => undefined,
					sessionId: "sess-late-list",
				});
				return hookResult;
			},
			{},
			(child) => React.createElement(LateListWrapper, null, child),
		);

		const initialContainerRo = ControllableResizeObserver.instances.find((i) => i.observed.has(viewport));
		assert.ok(initialContainerRo, "ResizeObserver 实例必须存在");
		assert.equal(listRef.current, null, "初始 loading 时 list 必须为空");

		// loading 完成，真实列表挂载
		await act(() => {
			triggerLoadFinish();
		});

		const currentList = listRef.current;
		assert.ok(currentList, "loading 完成后 list DOM 必须挂载");

		const activeContainerRo = ControllableResizeObserver.instances.find((i) => i.observed.has(currentList));
		assert.ok(
			activeContainerRo && activeContainerRo.observed.has(currentList),
			"loading 完成后延迟挂载的 list 必须被 ResizeObserver observe 监视！",
		);
	});
});

test("步骤1回归红测: 宽度改变后同节点无须重新 attach 即可继续按新代次接收测量", async () => {
	await withHookHost(async ({ React, load, mount, window, act, flushFrames }) => {
		ControllableResizeObserver.reset();
		globalThis.ResizeObserver = ControllableResizeObserver;
		window.ResizeObserver = ControllableResizeObserver;

		const mod = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
			globals: { ResizeObserver: ControllableResizeObserver },
		});
		const { useVirtualTimeline } = mod;

		const viewport = window.document.createElement("div");
		Object.defineProperty(viewport, "scrollTop", { value: 0, writable: true });
		Object.defineProperty(viewport, "clientHeight", { value: 600, writable: true });

		const list = window.document.createElement("div");
		const viewportRef = { current: viewport };
		const listRef = { current: list };

		const items = [{ kind: "message", message: { id: "m-1", role: "user", text: "hello", timestamp: 1 } }];
		let hookResult;
		let rowNode;

		const probe = await mount(
			() => {
				hookResult = useVirtualTimeline({
					items,
					viewportRef,
					listRef,
					isFollowing: false,
					applyReaderScrollTop: () => undefined,
					sessionId: "sess-width-resize",
				});
				return hookResult;
			},
			{},
			(child) =>
				React.createElement(
					React.Fragment,
					null,
					child,
					React.createElement("div", {
						ref: (el) => {
							rowNode = el;
							if (hookResult?.registerRowNode) {
								hookResult.registerRowNode("message:m-1", el);
							}
						},
						"data-timeline-measure-key": "message:m-1",
					}),
				),
		);

		const ro = ControllableResizeObserver.instances.at(-1);

		// 初次建立宽度 800 基线与 900px 行高
		await act(() => {
			ro.dispatchEntries([
				ControllableResizeObserver.createEntry(list, { width: 800, height: 180 }),
				ControllableResizeObserver.createEntry(rowNode, { width: 800, height: 900 }),
			]);
		});
		await flushFrames();

		// 宽度改变 800 -> 700，行高随之增加到 1100px（同一 rowNode 未重新 attach）
		await act(() => {
			const activeRo = ControllableResizeObserver.instances.at(-1);
			activeRo.dispatchEntries([ControllableResizeObserver.createEntry(list, { width: 700, height: 180 })]);
		});
		await flushFrames();

		await act(() => {
			const activeRo = ControllableResizeObserver.instances.at(-1);
			activeRo.dispatchEntries([ControllableResizeObserver.createEntry(rowNode, { width: 700, height: 1100 })]);
		});
		await flushFrames();

		const geom = probe.result().geometry;
		assert.equal(
			geom.heights[0],
			1100,
			`宽度改变后，仍挂载的行必须能够更新高度至 1100px，当前值: ${geom.heights[0]}`,
		);
	});
});

test("步骤1回归红测: 同 key 换 node 后，旧节点的已排队/迟到通知绝不能污染或覆盖新节点高度", async () => {
	await withHookHost(async ({ React, load, mount, window, act, flushFrames }) => {
		ControllableResizeObserver.reset();
		globalThis.ResizeObserver = ControllableResizeObserver;
		window.ResizeObserver = ControllableResizeObserver;

		const mod = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
			globals: { ResizeObserver: ControllableResizeObserver },
		});
		const { useVirtualTimeline } = mod;

		const viewport = window.document.createElement("div");
		Object.defineProperty(viewport, "scrollTop", { value: 0, writable: true });
		Object.defineProperty(viewport, "clientHeight", { value: 600, writable: true });

		const list = window.document.createElement("div");
		const viewportRef = { current: viewport };
		const listRef = { current: list };

		const items = [{ kind: "message", message: { id: "m-1", role: "user", text: "hello", timestamp: 1 } }];
		let hookResult;

		const nodeA = window.document.createElement("div");
		nodeA.setAttribute("data-timeline-measure-key", "message:m-1");

		const nodeB = window.document.createElement("div");
		nodeB.setAttribute("data-timeline-measure-key", "message:m-1");

		const probe = await mount(
			(props) => {
				hookResult = useVirtualTimeline({
					items,
					viewportRef,
					listRef,
					isFollowing: false,
					applyReaderScrollTop: () => undefined,
					sessionId: "sess-node-replace",
				});
				return hookResult;
			},
			{ activeNode: nodeA },
			(child) => React.createElement(React.Fragment, null, child),
		);

		// 先登记 nodeA
		act(() => {
			hookResult.registerRowNode("message:m-1", nodeA);
		});

		const ro = ControllableResizeObserver.instances.at(-1);

		// 登记并测量 nodeB（高度 1200px）
		act(() => {
			hookResult.registerRowNode("message:m-1", nodeB);
		});
		await act(() => {
			ro.dispatchEntries([
				ControllableResizeObserver.createEntry(list, { width: 800, height: 180 }),
				ControllableResizeObserver.createEntry(nodeB, { width: 800, height: 1200 }),
			]);
		});
		await flushFrames();

		assert.equal(probe.result().geometry.heights[0], 1200, "nodeB 测量高度应为 1200px");

		// 此时模拟来自 nodeA 的迟到通知（高度 400px）
		await act(() => {
			ro.dispatchLateEntries([ControllableResizeObserver.createEntry(nodeA, { width: 800, height: 400 })]);
		});
		await flushFrames();

		assert.equal(
			probe.result().geometry.heights[0],
			1200,
			"nodeA 的迟到通知绝不能覆盖 nodeB 的高度！",
		);
	});
});

test("步骤1回归红测: session A -> B -> A 切换后，第一代 A 的迟到通知绝不能污染第二代 A 的高度", async () => {
	await withHookHost(async ({ React, load, mount, window, act, flushFrames }) => {
		ControllableResizeObserver.reset();
		globalThis.ResizeObserver = ControllableResizeObserver;
		window.ResizeObserver = ControllableResizeObserver;

		const mod = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
			globals: { ResizeObserver: ControllableResizeObserver },
		});
		const { useVirtualTimeline } = mod;

		const viewport = window.document.createElement("div");
		Object.defineProperty(viewport, "scrollTop", { value: 0, writable: true });
		Object.defineProperty(viewport, "clientHeight", { value: 600, writable: true });

		const list = window.document.createElement("div");
		const viewportRef = { current: viewport };
		const listRef = { current: list };

		const items = [{ kind: "message", message: { id: "m-1", role: "user", text: "hello", timestamp: 1 } }];
		let hookResult;

		const nodeA1 = window.document.createElement("div");
		nodeA1.setAttribute("data-timeline-measure-key", "message:m-1");

		const nodeA2 = window.document.createElement("div");
		nodeA2.setAttribute("data-timeline-measure-key", "message:m-1");

		const probe = await mount(
			(props) => {
				hookResult = useVirtualTimeline({
					items,
					viewportRef,
					listRef,
					isFollowing: false,
					applyReaderScrollTop: () => undefined,
					sessionId: props.sessionId,
				});
				return hookResult;
			},
			{ sessionId: "sess-A" },
		);

		// 在 session A 第一代注册并测量 nodeA1
		act(() => {
			hookResult.registerRowNode("message:m-1", nodeA1);
		});
		const roA1 = ControllableResizeObserver.instances.at(-1);

		// 切到 session B
		await probe.rerender({ sessionId: "sess-B" });

		// 切回 session A（第二代 A）
		await probe.rerender({ sessionId: "sess-A" });

		act(() => {
			hookResult.registerRowNode("message:m-1", nodeA2);
		});
		const roA2 = ControllableResizeObserver.instances.at(-1);

		// 第二代 A 测得 1500px
		await act(() => {
			roA2.dispatchEntries([
				ControllableResizeObserver.createEntry(list, { width: 800, height: 180 }),
				ControllableResizeObserver.createEntry(nodeA2, { width: 800, height: 1500 }),
			]);
		});
		await flushFrames();

		// 此时第一代 A 的 observer 投递迟到通知（高度 300px）
		await act(() => {
			roA1.dispatchLateEntries([ControllableResizeObserver.createEntry(nodeA1, { width: 800, height: 300 })]);
		});
		await flushFrames();

		assert.equal(
			probe.result().geometry.heights[0],
			1500,
			"第一代 A 的迟到通知绝不能污染第二代 A 的高度！",
		);
	});
});


