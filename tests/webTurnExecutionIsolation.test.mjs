import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React, { act } from "react";
import { parseHTML } from "linkedom";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { useTurnExecution } = loadTsCommonJs(
	"src/renderer/src/components/session/turn/useTurnExecution.ts",
);

test("separate turns do not share execution state while one is streaming", async () => {
	const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		location: new URL("http://localhost/"),
		HTMLElement: window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	let root;
	try {
		for (const [key, value] of Object.entries(globals)) {
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
		const { createRoot } = await import("react-dom/client");
		root = createRoot(window.document.getElementById("root"));
		function Harness() {
			const history = useTurnExecution({
				agentRunning: false,
				isComplete: true,
				hasFinalAnswer: true,
				isLatestRun: false,
			});
			const streaming = useTurnExecution({
				agentRunning: true,
				isComplete: false,
				hasFinalAnswer: false,
				isLatestRun: true,
			});
			return React.createElement(
				"div",
				null,
				React.createElement("button", {
					id: "history",
					onClick: () => history.setStepsVisibleFromUser(true),
				}, String(history.stepsVisible)),
				React.createElement("span", { id: "streaming" }, String(streaming.stepsVisible)),
			);
		}
		await act(() => root.render(React.createElement(Harness)));
		assert.equal(window.document.getElementById("history").textContent, "false");
		assert.equal(window.document.getElementById("streaming").textContent, "false");
		await act(() => {
			window.document.getElementById("history").click();
		});
		assert.equal(window.document.getElementById("history").textContent, "true");
		assert.equal(window.document.getElementById("streaming").textContent, "false");
	} finally {
		if (root) await act(() => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globalThis[key];
		}
	}
});

test("web timeline does not park turn state in a shared web bucket", () => {
	const source = readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8");
	assert.match(source, /const presentationScope = useId\(\)/);
	assert.match(source, /props\.sessionId \|\| presentationScope/);
	assert.match(source, /useLayoutEffect\(/);
	assert.match(source, /rememberWebTurnPresentationKey\(aliases, key, aliasMap\)/);
	assert.match(source, /resolveWebTurnPresentationKey\(turnAliases, turnAliasMap\)/);
	assert.doesNotMatch(source, /bindWebTurnPresentationKey/);
	assert.doesNotMatch(source, /sessionId=\{props\.sessionId \?\? "web"\}/);
	const groups = readFileSync("src/renderer/src/web/webToolGroups.ts", "utf8");
	const collect = groups.slice(groups.indexOf("export function collectWebTurnAliases"), groups.indexOf("export function resolveWebTurnPresentationKey"));
	assert.doesNotMatch(collect, /toolCallId/);
});
