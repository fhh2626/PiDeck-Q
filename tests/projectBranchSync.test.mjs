import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync("src/renderer/src/hooks/useProjectCommands.ts", "utf8");

function loadProjectCommands(git, projects = {}, translate = (key) => key) {
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		Error,
		require(request) {
			if (request === "../desktopApi") {
				return { desktopApi: { git, projects } };
			}
			if (request === "../i18n") return { t: translate };
			if (request === "../rendererUtils") return { isChatProject: () => false };
			throw new Error(`Unexpected import: ${request}`);
		},
	});
	return module.exports.useProjectCommands;
}

test("addProject catches API failures and reports a translated toast", async () => {
	let toast;
	let refreshed = false;
	let selected = false;
	const useProjectCommands = loadProjectCommands(
		{},
		{ add: async () => { throw new Error("WSL unavailable"); } },
		(key, params) => `${key}:${params?.error ?? ""}`,
	);
	const commands = useProjectCommands({
		projects: [],
		activeProjectId: undefined,
		gitInfo: { current: null, branches: [] },
		setProjects: () => undefined,
		setActiveProjectId: () => { selected = true; },
		setGitInfo: () => undefined,
		setProjectBranch: () => undefined,
		refreshProjects: async () => { refreshed = true; },
		refreshProjectSessions: async () => undefined,
		onProjectRemoved: () => undefined,
		showToast: (message) => { toast = message; },
		overlays: { showConfirm: () => undefined, clearConfirm: () => undefined },
	});

	await assert.doesNotReject(() => commands.addProject());
	assert.equal(toast, "app.projectAddFailed:WSL unavailable");
	assert.equal(refreshed, false);
	assert.equal(selected, false);
});

test("addProject treats directory-picker cancellation as a no-op", async () => {
	let toast = false;
	let refreshed = false;
	const useProjectCommands = loadProjectCommands({}, { add: async () => null });
	const commands = useProjectCommands({
		projects: [],
		activeProjectId: undefined,
		gitInfo: { current: null, branches: [] },
		setProjects: () => undefined,
		setActiveProjectId: () => undefined,
		setGitInfo: () => undefined,
		setProjectBranch: () => undefined,
		refreshProjects: async () => { refreshed = true; },
		refreshProjectSessions: async () => undefined,
		onProjectRemoved: () => undefined,
		showToast: () => { toast = true; },
		overlays: { showConfirm: () => undefined, clearConfirm: () => undefined },
	});

	await commands.addProject();
	assert.equal(toast, false);
	assert.equal(refreshed, false);
});

test("failed branch checkout refreshes both the active Git panel and sidebar branch", async () => {
	const refreshed = { current: "develop", branches: ["main", "develop"] };
	const useProjectCommands = loadProjectCommands({
		checkout: async () => { throw new Error("checkout failed"); },
		branches: async () => refreshed,
	});
	let gitInfo;
	let sidebarBranch;
	const commands = useProjectCommands({
		projects: [],
		activeProjectId: "project-a",
		gitInfo: { current: "main", branches: ["main"] },
		setProjects: () => undefined,
		setActiveProjectId: () => undefined,
		setGitInfo: (value) => { gitInfo = value; },
		setProjectBranch: (projectId, branch) => { sidebarBranch = { projectId, branch }; },
		refreshProjects: async () => undefined,
		refreshProjectSessions: async () => undefined,
		onProjectRemoved: () => undefined,
		showToast: () => undefined,
		overlays: { showConfirm: () => undefined, clearConfirm: () => undefined },
	});

	await commands.switchBranch("develop");

	assert.deepEqual(gitInfo, refreshed);
	assert.deepEqual(sidebarBranch, { projectId: "project-a", branch: "develop" });
});
