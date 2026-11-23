import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { mountReact } from "./helpers/mountReact.mjs";

test("Progress exposes the value to assistive tech and moves the indicator", async () => {
	await mountReact(async ({ React, act, root, document }) => {
		const { Progress } = loadTsCommonJs("src/renderer/src/components/ui-shadcn/progress.tsx");
		await act(() => {
			root.render(React.createElement(Progress, { value: 40 }));
		});
		const bar = document.querySelector("[data-slot='progress']");
		const indicator = document.querySelector("[data-slot='progress-indicator']");
		assert.ok(bar, "progress root must render");
		assert.equal(bar.getAttribute("aria-valuenow"), "40");
		assert.equal(indicator.style.transform, "translateX(-60%)");
	});
});

test("Progress treats a missing value as an empty indicator", async () => {
	await mountReact(async ({ React, act, root, document }) => {
		const { Progress } = loadTsCommonJs("src/renderer/src/components/ui-shadcn/progress.tsx");
		await act(() => {
			root.render(React.createElement(Progress, {}));
		});
		const missing = document.querySelector("[data-slot='progress-indicator']");
		assert.equal(missing.style.transform, "translateX(-100%)");
		await act(() => {
			root.render(React.createElement(Progress, { value: 0 }));
		});
		assert.equal(
			document.querySelector("[data-slot='progress-indicator']").style.transform,
			"translateX(-100%)",
		);
	});
});
