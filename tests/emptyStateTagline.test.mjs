import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { mountReact } from "./helpers/mountReact.mjs";

function loadEmptyState(i18n) {
	return loadTsCommonJs("src/renderer/src/components/session/EmptyState.tsx", {
		stubs: {
			"../../i18n": i18n,
			"@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
		},
	});
}

test("empty state renders the project and no-project entry points from both locales", async () => {
	const i18n = loadTsCommonJs("src/renderer/src/i18n.ts");
	const zh = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts").zhCN;
	const en = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts").enUS;
	for (const key of [
		"app.emptyProjectTitleLead",
		"app.emptyProjectTitleAccent",
		"app.emptyProjectTitlePunct",
		"app.emptyNoProjectTitle",
		"app.emptyHasProject",
		"app.emptyNoProject",
	]) {
		assert.equal(typeof zh[key], "string", key);
		assert.equal(typeof en[key], "string", key);
		assert.notEqual(zh[key], en[key], `${key} should be translated`);
	}
	assert.equal(zh["app.emptyProjectTitleAccent"], "Session");
	assert.equal(en["app.emptyProjectTitleAccent"], "session");

	await mountReact(async ({ React, act, root, document, click }) => {
		const { EmptyState } = loadEmptyState(i18n);
		const created = [];
		i18n.setI18nLocale("zh-CN");
		await act(() => {
			root.render(React.createElement(EmptyState, {
				hasProject: true,
				onCreate: () => created.push("create"),
				eyebrow: "Workspace",
			}));
		});
		const project = document.querySelector("[data-empty-state='project']");
		assert.ok(project);
		assert.ok(project.textContent.includes(zh["app.emptyProjectTitleLead"]));
		assert.ok(project.textContent.includes(zh["app.emptyProjectTitleAccent"]));
		assert.ok(project.textContent.includes(zh["app.emptyProjectTitlePunct"]));
		assert.ok(project.textContent.includes(zh["app.emptyHasProject"]));
		const accent = [...project.querySelectorAll("span")].find((node) => node.textContent === "Session");
		assert.match(accent.className, /italic/);
		assert.ok(project.textContent.includes("Workspace"));
		await click(project.querySelector("button"));
		assert.deepEqual(created, ["create"]);

		i18n.setI18nLocale("en-US");
		await act(() => {
			root.render(React.createElement(EmptyState, {
				hasProject: false,
				onCreate: () => created.push("should-not"),
			}));
		});
		const empty = document.querySelector("[data-empty-state='no-project']");
		assert.ok(empty.textContent.includes(en["app.emptyNoProjectTitle"]));
		assert.ok(empty.textContent.includes(en["app.emptyNoProject"]));
		assert.equal(empty.querySelector("button"), null);
		assert.deepEqual(created, ["create"]);
	});
});
