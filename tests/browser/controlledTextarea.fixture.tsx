import React, { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Textarea } from "@/components/ui-shadcn/textarea";

declare global {
	interface Window {
		textareaFixture?: {
			setExternal: (value: string) => void;
			refNode: () => HTMLTextAreaElement | null;
			showEditor: (show: boolean) => void;
		};
	}
}

/** 合成数据：共享 Textarea 的四种受控用法（普通、过滤、拒绝、外部改值）与非受控用法。 */
function Fixture() {
	const [plain, setPlain] = useState("初始");
	const [filtered, setFiltered] = useState("");
	const [external, setExternal] = useState("");
	const [editing, setEditing] = useState(false);
	const [edited, setEdited] = useState("已有内容");
	const forwarded = useRef<HTMLTextAreaElement | null>(null);
	window.textareaFixture = { setExternal, refNode: () => forwarded.current, showEditor: setEditing };
	return (
		<main className="flex flex-col gap-2 p-4">
			<Textarea id="plain" value={plain} onChange={(event) => setPlain(event.target.value)} />
			<output id="plain-state">{plain}</output>
			<Textarea id="filtered" value={filtered} onChange={(event) => setFiltered(event.target.value.replace(/[0-9]/g, ""))} />
			<Textarea id="rejecting" value="固定" onChange={() => undefined} />
			<Textarea id="external" ref={forwarded} value={external} onChange={(event) => setExternal(event.target.value)} />
			<Textarea id="uncontrolled" defaultValue="自由" />
			{/* 编辑消息等场景：带初始内容 + autoFocus 挂载 */}
			{editing && <Textarea id="autofocus" autoFocus value={edited} onChange={(event) => setEdited(event.target.value)} />}
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
