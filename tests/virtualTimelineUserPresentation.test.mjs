import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { ControllableResizeObserver } from "./helpers/controllableResizeObserver.mjs";

const require = createRequire(import.meta.url);
const { Provider, createStore } = require("jotai");

for (const takeoverOffscreen of [false, true]) {
test(`real UserBubble keeps expansion through ${takeoverOffscreen ? "offscreen " : ""}ID takeover, metadata removal and a same-store remount`, async () => {
	await withHookHost(async ({ React, load, mount, window, act }) => {
		ControllableResizeObserver.reset();
		const presentation = load("src/renderer/src/atoms/timeline-presentation.ts");
		const context = load("src/renderer/src/components/session/timeline/timelinePresentationContext.tsx");
		const noContent = () => null;
		const childrenOnly = ({ children }) => React.createElement(React.Fragment, null, children);
		// Expansion and its context/atoms stay real. These unrelated surfaces do not
		// participate in a plain text user bubble's presentation lifecycle.
		const stubs = {
			"katex/dist/katex.min.css": {},
			"@/lib/density": { USER_TURN_BUBBLE: "user-bubble" },
			"./MarkdownStream": { MarkdownStream: noContent },
			"./MessageImage": { MessageImage: noContent, ImagePreviewModal: noContent },
			"./MessageCopyMenu": { CopyMenu: noContent },
			"./EmptyState": { EmptyState: noContent },
			"../ui-shadcn/textarea": { Textarea: noContent },
			"../ui-shadcn/button": { Button: noContent },
			"../ui-shadcn/tooltip": { Tooltip: childrenOnly, TooltipContent: noContent, TooltipTrigger: childrenOnly },
			"../../i18n": { t: (key) => key },
			"./ToolCallComponents": { ToolCard: noContent, ToolGroupCard: noContent },
			"./TimelineEventCards": { AskQuestionCard: noContent, CompactionCard: noContent, DiagnosticMessageCard: noContent, RespondingIndicator: noContent, ThinkingBlock: noContent },
			"./MessageShareModal": { MultiSelectModal: noContent },
			"./WorkspaceSurface": { SessionFileSummary: noContent, SessionHistoryModal: noContent },
			"./ComposerOverlayComponents": { FileContextMenu: noContent, PromptSuggestions: noContent },
			"../../hooks/useUserMessageVisionPoll": { useUserMessageVisionPoll: () => ({ showConverting: false, match: null }) },
			"./timeline/timelinePresentationContext": context,
			"../components/session/timeline/timelinePresentationContext": context,
			"../../atoms/timeline-presentation": presentation,
			"../atoms/timeline-presentation": presentation,
		};
		const { UserBubble } = load("src/renderer/src/components/session/SurfaceComponents.tsx", {
			stubs, globals: { ResizeObserver: ControllableResizeObserver },
		});
		const { useVirtualTimeline } = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
			globals: { ResizeObserver: ControllableResizeObserver },
		});
		const { useTimelinePresentationIdentities } = load("src/renderer/src/hooks/useTimelinePresentationIdentities.ts", {
			stubs: { "../atoms/timeline-presentation": presentation },
		});
		const { TimelineMessageRow } = load("src/renderer/src/components/session/timeline/TimelineMessageRow.tsx", {
			stubs: {
				"@/lib/density": stubs["@/lib/density"], "../../../i18n": stubs["../../i18n"],
				"../turn/TurnRow": { TurnRow: noContent }, "../SurfaceParts": { UserBubble },
				"../TimelineEventCards": stubs["./TimelineEventCards"], "./timelinePresentationContext": context,
			},
		});
		const sessionId = "accepted-bubble-remount";
		const store = createStore();
		const viewportRef = { current: null };
		const user = (id, requestId) => ({ kind: "message", message: {
			id, agentId: "agent", role: "user", text: Array.from({ length: 80 }, (_, line) => `Line ${line}`).join("\n"), timestamp: 1,
			...(requestId ? { meta: { optimisticRequestId: requestId } } : {}),
		} });
		Object.defineProperties(window.HTMLElement.prototype, {
			clientHeight: { configurable: true, get() { return this.classList.contains("line-clamp-8") ? 200 : 1200; } },
			scrollHeight: { configurable: true, get: () => 1200 },
		});
		function TimelineContent({ item, currentSession = sessionId, showBubble = true }) {
			const virtual = useVirtualTimeline({
				items: [item], viewportRef, sessionId: currentSession, isFollowing: false, applyReaderScrollTop() {},
			});
			useTimelinePresentationIdentities(currentSession, virtual.rowModel);
			const row = virtual.rowModel.rows[0];
			if (!showBubble) return null;
			return React.createElement(TimelineMessageRow, {
				item, rowKey: row.key, sessionId: currentSession, index: 0, totalItems: 1,
				fresh: false, isAgentBusy: false, isLastAgentRun: false, resendableMessageIds: new Set(), isSliding: false,
				onPreviewImage() {}, onOpenExternal() {}, onEnterMultiSelect() {},
			});
		}
		function Timeline({ currentStore = store, ...props }) {
			return React.createElement(Provider, { store: currentStore }, React.createElement(TimelineContent, props));
		}
		const probe = await mount(() => undefined, { item: user("request-1") }, (child) => React.createElement(Timeline, child.props.hookProps));
		const toggle = () => window.document.querySelector("button[aria-expanded]");
		assert.equal(toggle()?.getAttribute("aria-expanded"), "false");
		await act(() => toggle().dispatchEvent(new window.Event("click", { bubbles: true })));
		assert.equal(toggle()?.getAttribute("aria-expanded"), "true");
		if (takeoverOffscreen) await probe.rerender({ item: user("request-1"), showBubble: false });
		await probe.rerender({ item: user("accepted-1", "request-1"), showBubble: !takeoverOffscreen });
		assert.equal(toggle()?.getAttribute("aria-expanded"), takeoverOffscreen ? undefined : "true");
		await probe.rerender({ item: user("accepted-1"), showBubble: !takeoverOffscreen });
		assert.equal(toggle()?.getAttribute("aria-expanded"), takeoverOffscreen ? undefined : "true");
		await probe.unmount();
		await probe.rerender({ item: user("accepted-1") });
		assert.equal(toggle()?.getAttribute("aria-expanded"), "true", "the accepted identity must retain its saved expansion after the virtualizer context is recreated");
		await probe.unmount();
		await probe.rerender({ item: user("accepted-1"), currentStore: createStore() });
		assert.equal(toggle()?.getAttribute("aria-expanded"), "false", "another Jotai store must start with its own presentation");
		await probe.unmount();
		const separateStore = createStore();
		separateStore.set(presentation.getUserBubblePresentationAtom(sessionId, "message:accepted-1"), { messageExpanded: true, visionDetailOpen: false });
		separateStore.set(presentation.getUserBubblePresentationAtom(sessionId, "message:request-1"), { messageExpanded: false, visionDetailOpen: false });
		await probe.rerender({ item: user("accepted-1"), currentStore: separateStore });
		assert.equal(toggle()?.getAttribute("aria-expanded"), "true", "another store's canonical identity must remain independent of this store's request binding");
		await probe.unmount();
		await probe.rerender({ item: user("accepted-1"), currentSession: "other-session" });
		assert.equal(toggle()?.getAttribute("aria-expanded"), "false", "another session must not inherit request presentation");
		await probe.unmount();
		presentation.removeSessionPresentationState(sessionId);
		store.set(presentation.getUserBubblePresentationAtom(sessionId, "message:request-1"), { messageExpanded: true, visionDetailOpen: false });
		await probe.rerender({ item: user("accepted-1") });
		assert.equal(toggle()?.getAttribute("aria-expanded"), "false", "closing the session must clear identity links and presentation together");
		presentation.removeSessionPresentationState(sessionId);
		presentation.removeSessionPresentationState("other-session");
	});
});
}
