import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WebComposer } from "@/web/WebComposer";

declare global { interface Window { sentPrompts?: string[] } }
window.sentPrompts = [];

/** 合成数据：只挂真实 Web 输入框；样式表与正式渲染层同源（styles.css + web.css）。 */
function Fixture() {
	return (
		<main className="app wechat-shell flex h-full w-full flex-col">
			<WebComposer disabled={false} busy={false} onSend={(text) => window.sentPrompts?.push(text)} onStop={() => {}} />
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
