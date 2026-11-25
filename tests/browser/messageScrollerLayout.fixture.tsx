import { createRoot } from "react-dom/client";
import { MessageScroller, type MessageScrollerScrollApi } from "@/components/agents/message-scroller";
import "@/styles/tailwind.css";

let api: MessageScrollerScrollApi | null;
const timelineBox = new URLSearchParams(location.search).has("timelineBox");

createRoot(document.getElementById("root")!).render(
	<div style={{ width: 480, height: 360, display: "flex", flexDirection: "column" }}>
		<MessageScroller busy className="flex-1" scrollApiRef={(value) => { api = value; }}
			viewportProps={{ id: "viewport", tabIndex: 0, style: { paddingBlock: timelineBox ? "18px 24px" : undefined } }}>

			<div style={{ height: 1000 }}>History</div>
			<div id="card" style={{ height: 240 }}>Card</div>
			<div id="tail" style={{ height: 40 }}>Tail</div>
		</MessageScroller>
		<div id="composer" style={{ flex: "none", height: 120 }}>Composer</div>
	</div>,
);

export const fixture = {
	following: () => api?.isFollowing(),
	restoreAt: (top: number) => api?.restoreAt(top, { forceReading: true }),
	scrollToBottom: () => api?.scrollToBottom("smooth"),
};

Object.assign(window, { scrollerFixture: fixture });
