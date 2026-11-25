import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { ControllableResizeObserver } from "./helpers/controllableResizeObserver.mjs";

// The loader uses CommonJS Jotai. Its Provider must own this same context so each
// scenario has an isolated store rather than silently falling back to the default.
const { Provider, createStore } = createRequire(import.meta.url)("jotai");
const message = (id) => ({ id, agentId: "agent", role: "user", text: id, timestamp: 1 });
const rectangle = (top, height) => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 800, width: 800, height });

/** Exercise the real controller, scroller and virtualizer with controllable browser layout and event delivery. */
async function withSendTimeline(run, { busy = true, reducedMotion = true, restoreSessions = false, waitingForHistory = false, rowCount = 12, seedAnchor, fallbackAtTop = false } = {}) {
	await withHookHost(async ({ React, load, mount, window, act, flushFrames }) => {
		ControllableResizeObserver.reset();
		window.matchMedia = () => ({ matches: reducedMotion });
		const globals = { ResizeObserver: ControllableResizeObserver, Node: window.Node, performance, CSS: { escape: (value) => value } };
		const atoms = load("src/renderer/src/atoms/index.ts");
		const { useSessionTimelineController } = load("src/renderer/src/hooks/useSessionTimelineController.ts", {
			globals,
			stubs: {
				"../atoms": atoms,
				"../desktopApi": { desktopApi: { sessions: {
					readRecordMessagePage: () => waitingForHistory ? new Promise(() => {}) : Promise.resolve({ messages: [], total: 0, nextBefore: null }),
				} } },
				"../i18n": { t: (key) => key },
				"../utils/notice": { showNotice() {} },
			},
		});
		const { useSessionSend } = load("src/renderer/src/hooks/useSessionSend.ts", {
			globals: { crypto: globalThis.crypto }, stubs: { "../atoms": atoms, "../i18n": { t: (key) => key } },
		});
		let send;
		let submit = async () => ({ accepted: true });
		const { MessageScroller } = load("src/renderer/src/components/agents/message-scroller.tsx", {
			globals, stubs: { "motion/react": { useReducedMotion: () => reducedMotion } },
		});
		const { useVirtualTimeline } = load("src/renderer/src/hooks/useVirtualTimeline.ts", { globals });
		const { VirtualTimelineRows } = load("src/renderer/src/components/session/timeline/VirtualTimelineRows.tsx");
		const store = createStore();
		const listRef = { current: null }, adapterRef = { current: null };
		const heights = new Map(Array.from({ length: rowCount }, (_, index) => [`old-${index}`, 180]));
		let messages = [...heights.keys()].map(message);
		const sessionId = "send-scroll-session";
		const otherSessionId = "another-agent-session";
		const otherMessages = [message("other-agent-message")];
		const previouslySaved = { messageId: "not-loaded-yet", offsetTop: -35, savedAt: 1, visibleCount: 0 };
		const cache = () => store.set(atoms.cacheSessionMessagesAtom, { sessionId, messages, source: "runtime" });
		if (restoreSessions) {
			store.set(atoms.cacheSessionMessagesAtom, { sessionId: otherSessionId, messages: otherMessages, source: "runtime" });
			heights.set("other-agent-message", 180);
			if (waitingForHistory || seedAnchor) store.set(atoms.saveSessionScrollAnchorAtom, {
				sessionId, anchor: seedAnchor ? { ...previouslySaved, ...seedAnchor } : previouslySaved,
			});
			if (!waitingForHistory) cache();
		}
		let controller, virtualizer, viewport, scrollTop = 0;
		const viewportHeight = 500;
		const rowHeight = (row) => heights.get(row.querySelector("[data-message-id]")?.getAttribute("data-message-id")) ?? 0;
		const blockHeight = (block) => block.hasAttribute("data-virtual-spacer")
			? parseFloat(block.style.height) || 0
			: rowHeight(block) + (parseFloat(block.style.paddingBottom) || 0);
		const contentHeight = () => Array.from(listRef.current?.children ?? []).reduce((sum, block) => sum + blockHeight(block), 0);
		const currentTop = () => (scrollTop = Math.max(0, Math.min(scrollTop, contentHeight() - viewportHeight)));
		const blockTop = (block) => {
			let top = 0;
			for (const sibling of listRef.current?.children ?? []) {
				if (sibling === block) break;
				top += blockHeight(sibling);
			}
			return top - currentTop();
		};
		window.HTMLElement.prototype.getBoundingClientRect = function () {
			if (this === viewport) return rectangle(0, viewportHeight);
			if (this === listRef.current) return rectangle(-currentTop(), contentHeight());
			if (this.hasAttribute("data-virtual-spacer")) return rectangle(blockTop(this), blockHeight(this));
			const row = this.closest("[data-timeline-row-key]");
			return row ? rectangle(blockTop(row), this === row ? blockHeight(row) : rowHeight(row)) : rectangle(0, 0);
		};
		window.document.elementFromPoint = (_x, y) => Array.from(listRef.current?.querySelectorAll("[data-timeline-measure-key]") ?? [])
			.find((node) => { const box = node.getBoundingClientRect(); return box.top <= y && box.bottom > y; }) ?? listRef.current;
		const attachViewport = (node) => {
			viewport = node;
			controller.timelineRef.current = node;
			if (!node) {
				scrollTop = 0;
				return;
			}
			Object.defineProperties(node, {
				scrollTop: { configurable: true, get: currentTop, set: (top) => { scrollTop = Math.max(0, Math.min(top, contentHeight() - viewportHeight)); } },
				scrollTo: { configurable: true, value: ({ top }) => { node.scrollTop = top; } },
				clientTop: { configurable: true, value: 0 },
				clientHeight: { configurable: true, value: viewportHeight },
				scrollHeight: { configurable: true, get: contentHeight },
			});
		};
		function Timeline(props) {
			controller = useSessionTimelineController({ sessionId: props.sessionId, messages: restoreSessions ? undefined : props.messages });
			send = useSessionSend({
				sessionId: props.sessionId, templates: [], compact: async () => {},
				sendPrompt: (input) => submit(input), beforeOptimisticAppend: controller.beforeOptimisticAppend,
			});
			const source = restoreSessions ? controller.visibleMessages : props.messages;
			const items = React.useMemo(() => source.map((entry) => ({ kind: "message", message: entry })), [source]);
			const applyReaderScrollTop = React.useCallback((top, reason) => controller.scrollerScrollApiRef.current?.restoreAt(
				top, reason === "preserve-anchor" ? { preserveFollowState: true } : reason === "restore-reading" ? { forceReading: true } : undefined,
			), []);
			const reconcileLayoutClamp = React.useCallback(() => controller.scrollerScrollApiRef.current?.reconcileLayoutClamp(), []);
			virtualizer = useVirtualTimeline({
				items, viewportRef: controller.timelineRef, listRef, adapterRef,
				isFollowing: controller.autoScroll, reconcileLayoutClamp, applyReaderScrollTop, sessionId: props.sessionId,
			});
			React.useLayoutEffect(() => {
				if (!fallbackAtTop) return controller.registerViewportAdapter(adapterRef.current);
			}, []);
			return React.createElement(MessageScroller, {
				viewportRef: attachViewport, scrollApiRef: controller.scrollerScrollApiRef,
				initialFollowOutput: fallbackAtTop || controller.autoScroll, onFollowChange: controller.setAutoScrollFromScroller,
				busy, viewportProps: { onScroll: controller.handleTimelineScroll },
			}, React.createElement("div", { ref: virtualizer.registerListNode }, React.createElement(VirtualTimelineRows, {
				renderPlan: virtualizer.renderPlan, registerRowNode: virtualizer.registerRowNode,
				renderRow: (row) => React.createElement("div", { "data-message-id": row.anchorId }, row.anchorId),
			})));
		}
		const mounted = await mount(() => undefined, { messages }, (child) => {
			const { away, ...props } = child.props.hookProps;
			const owner = away ? otherSessionId : sessionId;
			return React.createElement(Provider, { store }, React.createElement(Timeline, { ...props, sessionId: owner, key: owner }));
		});
		const notifyResize = async () => act(() => {
			for (const observer of ControllableResizeObserver.instances) {
				observer.dispatchEntries(Array.from(observer.observed).map((node) => ControllableResizeObserver.createEntry(node, {
					height: node.hasAttribute("data-timeline-measure-key") ? node.getBoundingClientRect().height
						: node === viewport ? viewportHeight : contentHeight(),
					width: 800,
				})));
			}
		});
		const dispatchScroll = () => act(() => viewport.dispatchEvent(new window.Event("scroll")));
		const settle = async () => {
			for (let index = 0; index < 4; index += 1) {
				await notifyResize();
				await flushFrames();
				await dispatchScroll();
			}
		};
		if (!waitingForHistory && !seedAnchor) {
			await settle();
			assert.equal(controller.autoScroll, true);
		}
		const append = async (id, height = 48) => {
			heights.set(id, height);
			messages = [...messages, message(id)];
			if (restoreSessions) await act(cache);
			await mounted.rerender({ messages });
		};
		await run({
			controller: () => controller, viewport: () => viewport, adapter: () => adapterRef.current,
			gap: () => contentHeight() - viewportHeight - currentTop(), heights,
			geometry: () => virtualizer.geometry,
			append, settle, dispatchScroll, notifyResize, flushFrames, act, previouslySaved,
			startSend(prompt, sendPrompt) {
				submit = sendPrompt;
				store.set(atoms.setSessionDraftAtom, { sessionId, value: prompt });
				return send();
			},
			runtime: () => store.get(atoms.sessionRuntimeByIdAtom)[sessionId],
			emit(sourceChannel, payload, runtimeGeneration = 1) {
				store.set(atoms.applySessionRuntimeEventAtom, { sessionId, agentId: "agent", runtimeGeneration,
					sourceChannel, payload: { agentId: "agent", ...payload } });
			},
			async publishOptimisticSend(id, height = 90) {
				heights.set(id, height);
				messages = [...messages, { ...message(id), meta: { optimistic: true, optimisticPending: true, optimisticRequestId: id } }];
				await act(() => {
					store.set(atoms.sessionSendStateByIdAtom, { [sessionId]: { status: "activating", requestId: id } });
					store.set(atoms.cacheSessionMessagesAtom, { sessionId, messages, source: "optimistic" });
				});
			},
			async switchAway() { await mounted.rerender({ messages, away: true }); },
			async switchBack() { await mounted.rerender({ messages }); await settle(); },
			savedAnchor: () => store.get(atoms.sessionScrollAnchorByIdAtom)[sessionId],
			async scrollTo(top) { viewport.scrollTop = top; await dispatchScroll(); },
			async wheelUp(top) {
				await act(() => {
					const event = new window.Event("wheel");
					event.deltaY = -80;
					viewport.dispatchEvent(event);
					viewport.scrollTop = top;
				});
				await dispatchScroll();
			},
			async returnToBottom() { await act(() => controller.scrollToBottom()); await settle(); },
		});
	});
}

test("sending after a browser-clamped collapse keeps the real timeline following through late measurements", async () => {
	await withSendTimeline(async (timeline) => {
		const before = timeline.viewport().scrollTop;
		timeline.heights.set("old-11", 20);
		const clamped = timeline.viewport().scrollTop;
		assert.ok(clamped < before - 100, "the previous row must shrink enough to cause browser clamping");
		await timeline.append("sent-1");
		assert.ok(timeline.gap() > 2, "the new bubble must move the live edge after the clamp but before scroll delivery");
		await timeline.dispatchScroll();
		await timeline.settle();
		assert.equal(timeline.controller().autoScroll, true, "layout clamping must not become reader intent through the controller feedback loop");
		assert.ok(timeline.gap() <= 2);
		await timeline.append("sent-2", 220);
		await timeline.settle();
		assert.equal(timeline.controller().autoScroll, true);
		assert.ok(timeline.gap() <= 2, "the next send must also remain visible");
	});
});

for (const growth of [0, 100]) {
	test(`following survives two commits that clamp then ${growth ? "extend" : "restore"} the scroll range before notification`, async () => {
		await withSendTimeline(async (timeline) => {
			const viewport = timeline.viewport();
			const before = viewport.scrollHeight;
			const originalTop = viewport.scrollTop;
			timeline.heights.set("old-11", 20);
			await timeline.append("interim-output", 20);
			const clamped = viewport.scrollTop;
			assert.ok(clamped < originalTop - 100);
			assert.equal(timeline.gap(), 0);
			const restoredHeight = before - viewport.scrollHeight - 12;
			await timeline.append("resumed-output", restoredHeight + growth);
			assert.equal(viewport.scrollHeight, before + growth);
			assert.equal(viewport.scrollTop, clamped);
			await timeline.dispatchScroll();
			assert.equal(timeline.controller().autoScroll, true, "the delayed layout scroll must not become reader intent");
			// Equal final height can mean no ResizeObserver notification at all.
			for (let frame = 0; frame < 4; frame += 1) await timeline.flushFrames();
			assert.ok(timeline.gap() <= 2, "following must return to the new tail without waiting for a resize signal");
			await timeline.append("next-output", 220);
			await timeline.settle();
			assert.ok(timeline.gap() <= 2);
		});
	});
}

test("upward input after a layout clamp cancels the pending follow correction", async () => {
	await withSendTimeline(async (timeline) => {
		const viewport = timeline.viewport();
		timeline.heights.set("old-11", 20);
		await timeline.append("interim-output", 20);
		await timeline.wheelUp(viewport.scrollTop - 100);
		const reading = timeline.adapter().captureReadingAnchor();
		assert.equal(reading.status, "resolved");
		await timeline.append("resumed-output", 220);
		await timeline.settle();
		assert.equal(timeline.controller().autoScroll, false);
		const after = timeline.adapter().captureReadingAnchor();
		assert.equal(after.status, "resolved");
		assert.equal(after.anchor.messageId, reading.anchor.messageId);
		assert.equal(after.anchor.offsetTop, reading.anchor.offsetTop);
	});
});

test("switching away during an explicit return to the live edge discards the old anchor", async () => {
	await withSendTimeline(async (timeline) => {
		await timeline.wheelUp(timeline.viewport().scrollTop - 450);
		await timeline.flushFrames();
		await timeline.append("sent-before-switch", 90);
		// The engine has already received the return instruction, but the next scroll
		// event and the controller's deferred reading sample have not run yet.
		await timeline.act(() => timeline.controller().scrollToBottom());
		await timeline.switchAway();
		assert.ok(!timeline.savedAnchor(), "the older reading position must not be written back");
		await timeline.switchBack();
		assert.equal(timeline.controller().autoScroll, true);
		await timeline.append("reply-after-switch", 220);
		await timeline.settle();
		assert.ok(timeline.gap() <= 2);
	}, { restoreSessions: true });
});

test("sending at the live edge and immediately switching agents keeps following on return", async () => {
	await withSendTimeline(async (timeline) => {
		await timeline.wheelUp(timeline.viewport().scrollTop - 450);
		await timeline.flushFrames();
		await timeline.scrollTo(timeline.viewport().scrollHeight);
		assert.equal(timeline.controller().autoScroll, true);
		await timeline.publishOptimisticSend("composer-send");
		await timeline.switchAway();
		assert.equal(timeline.savedAnchor(), undefined);
		await timeline.switchBack();
		assert.equal(timeline.controller().autoScroll, true);
		await timeline.append("streamed-reply", 220);
		await timeline.settle();
		assert.ok(timeline.gap() <= 2);
	}, { restoreSessions: true });
});

test("a return to bottom is honored when Send beats the native scroll event", async () => {
	await withSendTimeline(async (timeline) => {
		await timeline.wheelUp(timeline.viewport().scrollTop - 450);
		await timeline.flushFrames();
		timeline.viewport().scrollTop = timeline.viewport().scrollHeight;
		assert.equal(timeline.gap(), 0);
		assert.equal(timeline.controller().autoScroll, false, "the event for the last scroll is still pending");
		let requestId;
		await timeline.act(async () => {
			await timeline.startSend("sent before native scroll", (input) => {
				requestId = input.requestId;
				timeline.heights.set(requestId, 102);
				return Promise.resolve({ accepted: true });
			});
		});
		await timeline.dispatchScroll();
		await timeline.switchAway();
		assert.equal(timeline.savedAnchor(), undefined);
		await timeline.switchBack();
		assert.equal(timeline.controller().autoScroll, true);
		assert.ok(timeline.gap() <= 2);
	}, { restoreSessions: true });
});

test("a real send preserves a reading position even when layout has clamped it to the bottom", async () => {
	await withSendTimeline(async (timeline) => {
		await timeline.wheelUp(timeline.viewport().scrollTop - 100);
		await timeline.flushFrames();
		const before = timeline.adapter().captureReadingAnchor().anchor;
		timeline.heights.set("old-11", 20);
		assert.ok(timeline.gap() <= 2);
		await timeline.act(async () => {
			await timeline.startSend("send from the clamped reading position", (input) => {
				timeline.heights.set(input.requestId, 102);
				return Promise.resolve({ accepted: true });
			});
		});
		await timeline.switchAway();
		assert.equal(timeline.savedAnchor().messageId, before.messageId);
		await timeline.switchBack();
		assert.equal(timeline.controller().autoScroll, false);
		assert.equal(timeline.adapter().captureReadingAnchor().anchor.messageId, before.messageId);
	}, { restoreSessions: true });
});

test("Send preserves a cross-row scroll whose native event is still pending", async () => {
	await withSendTimeline(async (timeline) => {
		const topOf = (id) => timeline.viewport().querySelector(`[data-message-id="${id}"]`).getBoundingClientRect().top;
		await timeline.wheelUp(timeline.geometry().prefixOffsets[4]);
		assert.equal(timeline.adapter().captureReadingAnchor().anchor.messageId, "old-4");
		timeline.viewport().scrollTop = timeline.geometry().prefixOffsets[6];
		assert.equal(topOf("old-6"), 0);
		await timeline.act(() => timeline.startSend("send ahead of scroll event", ({ requestId }) => {
			timeline.heights.set(requestId, 102);
			return Promise.resolve({ accepted: true });
		}));
		assert.equal(topOf("old-6"), 0);
		await timeline.dispatchScroll();
		await timeline.switchAway();
		assert.equal(timeline.savedAnchor().messageId, "old-6");
		timeline.heights.set("old-5", 400);
		await timeline.switchBack();
		assert.equal(topOf("old-6"), 0);
	}, { restoreSessions: true, rowCount: 24 });
});

test("a reading anchor on a pending bubble restores to the confirmed row after switching agents", async () => {
	await withSendTimeline(async (timeline) => {
		await timeline.publishOptimisticSend("request-id", 720);
		await timeline.settle();
		await timeline.wheelUp(timeline.viewport().scrollTop - 120);
		await timeline.switchAway();
		assert.equal(timeline.savedAnchor().messageId, "request-id");
		const offset = timeline.savedAnchor().offsetTop;
		timeline.heights.set("native-uuid", 720);
		await timeline.act(() => timeline.emit("agents:message", { messages: [
			...Array.from({ length: 12 }, (_, index) => message(`old-${index}`)),
			{ ...message("native-uuid"), text: "request-id", meta: { optimisticRequestId: "request-id" } },
		] }));
		await timeline.switchBack();
		assert.equal(timeline.controller().autoScroll, false);
		const anchor = timeline.adapter().captureReadingAnchor().anchor;
		assert.equal(anchor.messageId, "native-uuid");
		assert.equal(anchor.offsetTop, offset);
	}, { restoreSessions: true });
});

for (const switchBeforeSnapshot of [true, false]) {
test(`a sticky snapshot preserves the archived summary when switching ${switchBeforeSnapshot ? "before" : "after"} the snapshot`, async () => {
	await withSendTimeline(async (timeline) => {
		const retained = Array.from({ length: 12 }, (_, index) => message(`old-${index}`));
		const summary = { ...message("agent-meta-1"), role: "system", text: "Previous summary",
			meta: { type: "compaction", tokensBefore: 200 } };
		const archiveId = `${summary.id}-archived-summary-1`;
		timeline.heights.set(summary.id, 720);
		timeline.heights.set(archiveId, 720);
		await timeline.act(() => timeline.emit("agents:message", {
			messages: [...retained.slice(0, 10), summary, ...retained.slice(10)],
			windowStartFilePos: 8, fileVersion: "1:1",
		}));
		await timeline.settle();
		await timeline.wheelUp(timeline.viewport().scrollTop - 120);
		const before = timeline.adapter().captureReadingAnchor().anchor;
		assert.equal(before.messageId, summary.id);
		if (switchBeforeSnapshot) {
			await timeline.switchAway();
			assert.equal(timeline.savedAnchor().messageId, summary.id);
		}
		await timeline.act(() => timeline.emit("agents:message", {
			messages: [{ ...summary, text: "New summary", timestamp: 2 }, ...retained.slice(10)],
			stickyHistory: true, preserveHistory: true, windowStartFilePos: 16, fileVersion: "2:2",
		}));
		if (!switchBeforeSnapshot) {
			await timeline.switchAway();
			assert.equal(timeline.savedAnchor().messageId, archiveId);
		}
		await timeline.switchBack();
		assert.ok(timeline.controller().visibleMessages.some((row) => row.id === archiveId && row.text === summary.text));
		const anchor = timeline.adapter().captureReadingAnchor().anchor;
		assert.equal(anchor.messageId, archiveId);
		assert.equal(anchor.offsetTop, before.offsetTop);
	}, { restoreSessions: true });
});
}

test("learning a compaction ID keeps the position within the already visible summary", async () => {
	await withSendTimeline(async (timeline) => {
		const retained = Array.from({ length: 12 }, (_, index) => message(`old-${index}`));
		const summary = { ...message("agent-meta-1"), role: "system", text: "Summary awaiting its history ID",
			meta: { type: "compaction", tokensBefore: 200 } };
		timeline.heights.set(summary.id, 720);
		const publish = (card) => timeline.emit("agents:message", {
			messages: [...retained.slice(0, 10), card, ...retained.slice(10)],
			windowStartFilePos: 8, fileVersion: "1:1",
		});
		await timeline.act(() => publish(summary));
		await timeline.settle();
		await timeline.wheelUp(timeline.viewport().scrollTop - 120);
		const before = timeline.adapter().captureReadingAnchor().anchor;
		assert.equal(before.messageId, summary.id);
		assert.ok(before.offsetTop < 0);
		await timeline.act(() => publish({ ...summary, meta: { ...summary.meta, compactionId: "compaction-entry" } }));
		await timeline.switchAway();
		await timeline.switchBack();
		const after = timeline.adapter().captureReadingAnchor().anchor;
		assert.equal(after.messageId, summary.id);
		assert.equal(after.identity.id, "compaction-entry");
		assert.equal(after.offsetTop, before.offsetTop);
	}, { restoreSessions: true });
});

for (const command of ["/todo", "/todo-goal"]) {
	test(`a reading anchor on a pending ${command} bubble restores to its acknowledged task card`, async () => {
		await withSendTimeline(async (timeline) => {
			let requestId;
			await timeline.act(() => timeline.startSend(`${command} ${"Long task description ".repeat(50)}`, (input) => {
				requestId = input.requestId;
				timeline.heights.set(requestId, 720);
				return Promise.resolve({ accepted: true });
			}));
			await timeline.settle();
			await timeline.wheelUp(timeline.viewport().scrollTop - 120);
			await timeline.switchAway();
			assert.ok(requestId);
			assert.equal(timeline.savedAnchor().messageId, requestId);
			const card = { ...message("task-card"), role: "system",
				meta: { type: "todoTask", optimisticRequestId: requestId } };
			timeline.heights.set(card.id, 720);
			await timeline.act(() => timeline.emit("agents:message", { messages: [
				...Array.from({ length: 12 }, (_, index) => message(`old-${index}`)), card,
			] }));
			await timeline.switchBack();
			assert.ok(!timeline.controller().visibleMessages.some((row) => row.id === requestId));
			assert.equal(timeline.adapter().captureReadingAnchor().anchor.messageId, card.id);
		}, { restoreSessions: true });
	});
}

test("a send HTTP acknowledgement cannot make an already-settled Agent busy again", async () => {
	await withSendTimeline(async (timeline) => {
		let accept, pending;
		await timeline.act(() => {
			timeline.emit("agents:state", { status: "idle" });
			pending = timeline.startSend("fast prompt", () => new Promise((resolve) => { accept = resolve; }));
		});
		await timeline.switchAway();
		await timeline.act(() => {
			timeline.emit("agents:state", { status: "running" });
			timeline.emit("agents:state", { status: "idle" });
		});
		assert.equal(timeline.runtime().status, "idle");
		await timeline.act(async () => {
			accept({ accepted: true, agentId: "agent", runtimeGeneration: 1 });
			await pending;
		});
		await timeline.switchBack();
		assert.equal(timeline.runtime().status, "idle");
	}, { restoreSessions: true });
});

for (const scenario of [
	{ name: "an activation idle event alone does not suppress the accepted-send busy fallback", generation: 1, settled: false, expected: "running" },
	{ name: "an acknowledgement cannot revive a turn that settled on the prewarmed binding", generation: 1, settled: true, expected: "idle" },
	{ name: "an acknowledgement cannot make a replacement generation busy", generation: 2, settled: false, expected: "idle" },
]) {
	test(scenario.name, async () => {
		await withSendTimeline(async (timeline) => {
			let accept, pending;
			await timeline.act(() => {
				pending = timeline.startSend("prewarming prompt", () => new Promise((resolve) => { accept = resolve; }));
			});
			await timeline.switchAway();
			await timeline.act(() => {
				timeline.emit("agents:state", { status: "idle" }, scenario.generation);
				if (scenario.settled) {
					timeline.emit("agents:state", { status: "running" }, scenario.generation);
					timeline.emit("agents:state", { status: "idle" }, scenario.generation);
				}
			});
			assert.equal(timeline.runtime().status, "idle");
			await timeline.act(async () => {
				accept({ accepted: true, agentId: "agent", runtimeGeneration: 1 });
				await pending;
			});
			assert.equal(timeline.runtime().runtimeGeneration, scenario.generation);
			assert.equal(timeline.runtime().status, scenario.expected);
		}, { restoreSessions: true });
	});
}

test("an acknowledgement still binds a newly started Agent when its events have not arrived", async () => {
	await withSendTimeline(async (timeline) => {
		await timeline.act(async () => {
			await timeline.startSend("cold prompt", async () => ({ accepted: true, agentId: "agent", runtimeGeneration: 1 }));
		});
		assert.equal(timeline.runtime().agentId, "agent");
		assert.equal(timeline.runtime().status, "running");
	}, { restoreSessions: true });
});

test("sending while reading and immediately switching restores the latest reading passage", async () => {
	await withSendTimeline(async (timeline) => {
		await timeline.wheelUp(timeline.viewport().scrollTop - 450);
		await timeline.flushFrames();
		await timeline.scrollTo(timeline.viewport().scrollTop - 250);
		const reading = timeline.adapter().captureReadingAnchor();
		assert.equal(reading.status, "resolved");
		await timeline.publishOptimisticSend("send-from-history");
		await timeline.switchAway();
		assert.equal(timeline.savedAnchor().messageId, reading.anchor.messageId);
		assert.equal(timeline.savedAnchor().offsetTop, reading.anchor.offsetTop);
		await timeline.switchBack();
		assert.equal(timeline.controller().autoScroll, false);
		const restored = timeline.adapter().captureReadingAnchor();
		assert.equal(restored.anchor.messageId, reading.anchor.messageId);
		assert.equal(restored.anchor.offsetTop, reading.anchor.offsetTop);
	}, { restoreSessions: true });
});

for (const stage of ["before scroll", "after scroll", "after resize settles"]) {
	test(`switching after a layout clamp preserves the reading offset (${stage})`, async () => {
		await withSendTimeline(async (timeline) => {
			await timeline.wheelUp(timeline.viewport().scrollTop - 100);
			await timeline.flushFrames();
			const reading = timeline.adapter().captureReadingAnchor();
			assert.equal(reading.status, "resolved");
			timeline.heights.set("old-11", 20);
			assert.ok(timeline.gap() <= 2);
			if (stage === "after scroll") await timeline.dispatchScroll();
			if (stage === "after resize settles") await timeline.settle();
			await timeline.switchAway();
			assert.equal(timeline.savedAnchor().messageId, reading.anchor.messageId);
			assert.equal(timeline.savedAnchor().offsetTop, reading.anchor.offsetTop);
			await timeline.switchBack();
			assert.equal(timeline.controller().autoScroll, false, "a clamped restore must not resume following");
			await timeline.append("reply-after-clamped-restore", 220);
			await timeline.settle();
			assert.equal(timeline.controller().autoScroll, false);
			const anchorNode = timeline.viewport().querySelector(`[data-message-id="${reading.anchor.messageId}"]`);
			assert.equal(anchorNode.getBoundingClientRect().top, reading.anchor.offsetTop);
		}, { restoreSessions: true });
	});
}

test("an upward landing in a spacer survives switching away before scroll delivery", async () => {
	await withSendTimeline(async (timeline) => {
		const viewport = timeline.viewport();
		await timeline.wheelUp(viewport.scrollTop - 100);
		const geometry = timeline.geometry();
		assert.equal(viewport.querySelector('[data-message-id="old-2"]'), null);
		assert.equal(geometry.heights[2], 180);
		timeline.heights.set("old-2", 900);
		viewport.scrollTop = geometry.prefixOffsets[2] + geometry.heights[2] - 40;
		await timeline.switchAway();
		await timeline.switchBack();
		const restoredRow = timeline.viewport().querySelector('[data-message-id="old-2"]');
		assert.equal(restoredRow.getBoundingClientRect().bottom, 40);
		assert.equal(timeline.controller().autoScroll, false);
	}, { restoreSessions: true, rowCount: 44 });
});

test("returning to the bottom cancels a restore waiting for its history row", async () => {
	await withSendTimeline(async (timeline) => {
		await timeline.flushFrames();
		await timeline.returnToBottom();
		await timeline.append(timeline.previouslySaved.messageId, 180);
		await timeline.settle();
		assert.equal(timeline.controller().autoScroll, true);
		assert.ok(timeline.gap() <= 2);
		await timeline.switchAway();
		assert.equal(timeline.savedAnchor(), undefined);
	}, { restoreSessions: true, waitingForHistory: true });
});

test("an explicit message jump supersedes a restore scheduled for the next frame", async () => {
	await withSendTimeline(async (timeline) => {
		await timeline.act(() => timeline.controller().jumpToMessage("old-8"));
		await timeline.settle();
		assert.equal(timeline.adapter().captureReadingAnchor().anchor.messageId, "old-8");
	}, { restoreSessions: true, seedAnchor: { messageId: "old-3", offsetBottom: 25 } });
});

test("a DOM fallback restore unlocks following even if the position is unchanged", async () => {
	await withSendTimeline(async (timeline) => {
		assert.equal(timeline.viewport().scrollTop, 0);
		await timeline.settle();
		assert.equal(timeline.controller().scrollerScrollApiRef.current.isFollowing(), false);
		await timeline.append("new-output", 800);
		await timeline.settle();
		assert.equal(timeline.viewport().scrollTop, 0);
	}, { restoreSessions: true, rowCount: 1, seedAnchor: { messageId: "old-0", offsetTop: 0 }, fallbackAtTop: true });
});

test("switching before history loads leaves the unresolved saved anchor intact", async () => {
	await withSendTimeline(async (timeline) => {
		await timeline.flushFrames();
		await timeline.dispatchScroll();
		await timeline.flushFrames();
		await timeline.switchAway();
		assert.deepEqual(timeline.savedAnchor(), timeline.previouslySaved);
	}, { restoreSessions: true, waitingForHistory: true });
});

test("sending while reading preserves the passage until the reader explicitly returns to the bottom", async () => {
	await withSendTimeline(async (timeline) => {
		await timeline.wheelUp(timeline.viewport().scrollTop - 500);
		assert.equal(timeline.controller().autoScroll, false);
		const reading = timeline.adapter().captureReadingAnchor();
		assert.equal(reading.status, "resolved");
		timeline.heights.set("old-11", 20);
		await timeline.append("sent-while-reading");
		await timeline.settle();
		const after = timeline.adapter().captureReadingAnchor();
		assert.equal(after.status, "resolved");
		assert.equal(after.anchor.messageId, reading.anchor.messageId);
		assert.equal(after.anchor.offsetTop, reading.anchor.offsetTop);
		assert.equal(timeline.controller().autoScroll, false);
		await timeline.returnToBottom();
		await timeline.append("sent-after-return", 220);
		await timeline.settle();
		assert.equal(timeline.controller().autoScroll, true);
		assert.ok(timeline.gap() <= 2);
	});
});

test("a real upward gesture during send wins over collapse compensation and later output", async () => {
	await withSendTimeline(async (timeline) => {
		timeline.heights.set("old-11", 20);
		const clamped = timeline.viewport().scrollTop;
		await timeline.append("sent-before-escape");
		await timeline.wheelUp(clamped - 80);
		const reading = timeline.adapter().captureReadingAnchor();
		assert.equal(reading.status, "resolved");
		await timeline.settle();
		await timeline.append("output-after-escape", 220);
		await timeline.settle();
		const after = timeline.adapter().captureReadingAnchor();
		assert.equal(after.status, "resolved");
		assert.equal(after.anchor.messageId, reading.anchor.messageId);
		assert.equal(after.anchor.offsetTop, reading.anchor.offsetTop);
		assert.equal(timeline.controller().autoScroll, false, "explicit reader input must keep priority over delayed layout events");
	});
});

test("an idle reader stays unlocked when late row measurements clamp anchor correction to the bottom", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	await withSendTimeline(async (timeline) => {
		// Expire the end-of-stream transition so the scroller uses its idle smooth
		// behavior, while no send or agent output can explain a renewed follow lock.
		await timeline.act(() => context.mock.timers.tick(151));
		for (const id of ["old-11", "old-10"]) {
			const bottom = timeline.viewport().scrollTop;
			await timeline.wheelUp(bottom - 40);
			assert.equal(timeline.viewport().scrollTop, bottom - 40, "the first upward gesture must move the transcript");
			assert.equal(timeline.controller().autoScroll, false);
			timeline.heights.set(id, 20);
			await timeline.settle();
			assert.ok(timeline.gap() <= 2, "the late shrink must clamp the saved reading position to the new bottom");
			assert.equal(timeline.controller().autoScroll, false, "preserving an anchor must retain the reader's escape from following");
		}
		const reading = timeline.adapter().captureReadingAnchor();
		assert.equal(reading.status, "resolved");
		const anchorNode = timeline.viewport().querySelector(`[data-message-id="${reading.anchor.messageId}"]`);
		assert.ok(anchorNode);
		assert.ok(anchorNode.getBoundingClientRect().top > reading.anchor.offsetTop, "the shorter list cannot currently fit the saved passage at its requested offset");
		await timeline.append("later-history-row", 220);
		await timeline.settle();
		const after = timeline.adapter().captureReadingAnchor();
		assert.equal(after.status, "resolved");
		// The temporarily clamped passage can now be restored. Its message and
		// offset, rather than the clamped absolute position, define reading intent.
		assert.equal(after.anchor.messageId, reading.anchor.messageId);
		assert.equal(after.anchor.offsetTop, reading.anchor.offsetTop);
		const restoredNode = timeline.viewport().querySelector(`[data-message-id="${reading.anchor.messageId}"]`);
		assert.ok(restoredNode);
		assert.equal(restoredNode.getBoundingClientRect().top, reading.anchor.offsetTop, "the actual mounted passage must return to the saved reading offset");
		assert.equal(timeline.controller().autoScroll, false);
		assert.ok(timeline.gap() > 2, "later layout work must not pull the reader back to the live edge");
	}, { busy: false, reducedMotion: false });
});

for (const navigation of ["restoreMessage", "jumpToMessage"]) {
	test(`an explicit ${navigation} to the live edge resumes following after idle reading`, async () => {
		await withSendTimeline(async (timeline) => {
			await timeline.wheelUp(timeline.viewport().scrollTop - 300);
			assert.equal(timeline.controller().autoScroll, false);
			await timeline.act(() => {
				assert.equal(timeline.adapter()[navigation]("old-11", 0), true);
			});
			await timeline.settle();
			assert.equal(timeline.controller().autoScroll, true, "explicit navigation keeps its existing live-edge follow behavior");
			await timeline.append("after-explicit-navigation", 220);
			await timeline.settle();
			assert.equal(timeline.controller().autoScroll, true);
			assert.ok(timeline.gap() <= 2);
		}, { busy: false });
	});
}
