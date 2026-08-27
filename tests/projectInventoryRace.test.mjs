import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const projectSyncSource = readFileSync(
	"src/renderer/src/hooks/useProjectSync.ts",
	"utf8",
);

function deferred() {
	let resolve;
	const promise = new Promise((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

/** 加载 useProjectSync，并记录它对文件树 state 的公开写入行为。 */
function createRuntime(options = {}) {
	const output = ts.transpileModule(projectSyncSource, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
	const fileWrites = [];
	let activeProjectRef;
	const module = { exports: {} };
	const context = {
		module,
		exports: module.exports,
		require(request) {
			if (request === "react") {
				return {
					useRef: (initial) => {
						const ref = { current: initial };
						if (typeof initial === "string" && initial.startsWith("project-")) {
							activeProjectRef = ref;
						}
						return ref;
					},
					useState: (initial) => {
						const isFileState = Array.isArray(initial) || Array.isArray(initial?.files);
						const current = isFileState && options.initialFileState
							? (Array.isArray(initial) ? options.initialFileState.files : options.initialFileState)
							: initial;
						return [
							current,
							(next) => {
								if (!isFileState) return;
								fileWrites.push(Array.isArray(next) ? next : next.files);
							},
						];
					},
					useEffect: () => undefined,
				};
			}
			if (request === "../atoms/session-selectors") {
				return { sessionRecordToSummary: (session) => session };
			}
			if (request === "../utils/projectInventoryRequests") {
				return { requestProjectInventory: (list) => list() };
			}
			throw new Error(`Unexpected runtime import: ${request}`);
		},
		setTimeout,
		clearTimeout,
		Promise,
	};
	vm.runInNewContext(output, context);
	return {
		useProjectSync: context.module.exports.useProjectSync,
		fileWrites,
		setActiveProjectId(projectId) {
			if (!activeProjectRef) throw new Error("active project ref is not initialized");
			activeProjectRef.current = projectId;
		},
	};
}

function makeInput(activeProjectId, listFiles) {
	return {
		projects: [],
		activeProjectId,
		setProjects: () => undefined,
		setActiveProjectId: () => undefined,
		replaceProjectSessions: () => undefined,
		api: {
			projects: { list: async () => [] },
			git: {
				worktreeList: async () => [],
				branches: async () => ({ current: null, branches: [] }),
			},
			sessions: { listCatalog: async () => [] },
			files: { list: listFiles },
		},
		showToast: () => undefined,
		setSessionCatalogLoadState: () => undefined,
		t: (key) => key,
	};
}

test("the render after a project switch never exposes files owned by the previous project", () => {
	const { useProjectSync } = createRuntime({
		initialFileState: {
			projectId: "project-a",
			files: [{ path: "A:/stale.ts", name: "stale.ts" }],
		},
	});
	const sync = useProjectSync(makeInput("project-b", async () => []));

	assert.equal(sync.files.length, 0);
});

test("a late file response from the previous project cannot replace the active project tree", async () => {
	const oldProject = deferred();
	const activeProject = deferred();
	const runtime = createRuntime();
	const sync = runtime.useProjectSync(makeInput("project-a", (projectId) =>
		projectId === "project-a" ? oldProject.promise : activeProject.promise,
	));

	const oldRequest = sync.refreshFiles("project-a", true);
	runtime.setActiveProjectId("project-b");
	const activeRequest = sync.refreshFiles("project-b", true);
	activeProject.resolve([{ path: "B:/current.ts", name: "current.ts" }]);
	await activeRequest;
	oldProject.resolve([{ path: "A:/stale.ts", name: "stale.ts" }]);
	await oldRequest;

	assert.equal(runtime.fileWrites.length, 1);
	assert.equal(runtime.fileWrites[0][0].path, "B:/current.ts");
});

test("a stale project refresh started after switching cannot cancel the active project load", async () => {
	const oldProject = deferred();
	const activeProject = deferred();
	const { useProjectSync, fileWrites } = createRuntime();
	const sync = useProjectSync(makeInput("project-b", (projectId) =>
		projectId === "project-a" ? oldProject.promise : activeProject.promise,
	));

	const activeRequest = sync.refreshFiles("project-b", true);
	// 模拟旧项目复制/移动操作在切换完成后才进入 then(refreshFiles)。
	const staleCallbackRequest = sync.refreshFiles("project-a", true);
	oldProject.resolve([{ path: "A:/stale.ts", name: "stale.ts" }]);
	await staleCallbackRequest;
	activeProject.resolve([{ path: "B:/current.ts", name: "current.ts" }]);
	await activeRequest;

	assert.equal(fileWrites.length, 1);
	assert.equal(fileWrites[0][0].path, "B:/current.ts");
});
