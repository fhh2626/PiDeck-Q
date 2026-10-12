import React from "react";
import ReactDOM from "react-dom/client";
import { WebThinkingBlock } from "@/web/WebTimeline";

function ThinkingDensityFixture() {
	return (
		<main className="app wechat-shell">
			<section className="chat-pane">
				<div className="message-timeline">
					<div className="message-list flex flex-col gap-1.5 px-3 py-2.5">
						<WebThinkingBlock text="A concise preview of the current reasoning." />
					</div>
				</div>
			</section>
		</main>
	);
}

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<ThinkingDensityFixture />);
