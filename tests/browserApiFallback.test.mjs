import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadBrowserApiModule(fetch) {
	const source = readFileSync("src/renderer/src/browserApi.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const previewProjects = [{ id: "preview-project", name: "Preview" }];
	const sandbox = {
		fetch,
		URLSearchParams,
		exports: {},
		require: (specifier) => {
			if (specifier === "./i18n") {
				return {
					t: (key, params) => `${key}:${params?.status ?? ""}:${params?.statusText ?? ""}`,
				};
			}
			if (specifier === "../../shared/sessionDeleteResponse") {
				const parser = { exports: {} };
				vm.runInNewContext(ts.transpileModule(readFileSync("src/shared/sessionDeleteResponse.ts", "utf8"), {
					compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
				}).outputText, parser);
				return parser.exports;
			}
			if (specifier === "./previewApi") {
				return {
					createPreviewApi: () => ({
						projects: {
							list: async () => previewProjects,
						},
						sessions: {
							list: async () => [],
						},
						settings: {
							get: async () => ({ webServiceEnabled: false }),
						},
					}),
				};
			}
			throw new Error(`Unexpected require: ${specifier}`);
		},
		window: {
			setInterval: () => 1,
			clearInterval: () => undefined,
		},
	};
	vm.runInNewContext(outputText, sandbox, {
		filename: "browserApi.ts",
	});
	return sandbox.exports;
}

test("falls back to the preview project list when Vite returns HTML for web state", async () => {
	const { createBrowserApi } = loadBrowserApiModule(async () => ({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => {
			throw new Error("Unexpected token <");
		},
	}));
	const projects = await createBrowserApi().projects.list();
	assert.deepEqual(projects, [{ id: "preview-project", name: "Preview" }]);
});

test("browser polling publishes the replacement revision and paging seam even when rows are unchanged", async () => {
	const runtime = { sessionId: "session", agentId: "agent", runtimeGeneration: 1 };
	const messages = [{ id: "recent", role: "user", text: "unchanged runtime window" }];
	let revision = 0;
	let filePos = 21;
	const { createBrowserApi } = loadBrowserApiModule(async () => ({
		ok: true,
		json: async () => ({ projects: [], sessions: [], runtimes: [runtime],
			messagesBySession: { session: messages }, messageWindowsBySession: { session: {
				historyMutationRevision: revision, windowStart: 17, windowStartFilePos: filePos, totalLength: 18,
			} } }),
	}));
	const api = createBrowserApi();
	const frames = [];
	const unsubscribe = api.sessions.onRuntimeEvent((event) => {
		if (event.sourceChannel === "sessions:messages") frames.push(event.payload);
	});
	try {
		await api.projects.list();
		revision = 1;
		await api.projects.list();
		assert.deepEqual(frames.map((frame) => frame.historyMutationRevision), [0, 1]);
		assert.deepEqual(frames.map((frame) => frame.windowStartFilePos), [21, 21]);
		filePos = 22;
		await api.projects.list();
		assert.deepEqual(frames.map((frame) => frame.windowStartFilePos), [21, 21, 22]);
		assert.equal(frames.at(-1).windowStart, 17);
		assert.equal(frames.at(-1).totalLength, 18);
	} finally {
		unsubscribe();
	}
});

test("browser history forwards entry and numeric cursors to the turn pager", async () => {
	const requests = [];
	const page = { messages: [{ id: "older", text: "older edited turn" }], total: 2, nextBefore: null };
	const { createBrowserApi } = loadBrowserApiModule(async (url) => {
		requests.push(new URL(url, "http://example.test"));
		return { ok: true, json: async () => page };
	});
	const api = createBrowserApi();
	assert.deepEqual(await api.sessions.readRecordMessagePage("session", undefined, 3,
		{ unit: "turn", beforeEntryId: "u+1" }), page);
	await api.sessions.readRecordMessagePage("session", 21, 2, { unit: "turn" });
	await api.sessions.readRecordMessagePage("session", 15, 5, { unit: "message" });
	assert.deepEqual(requests.map((url) => [url.pathname, Object.fromEntries(url.searchParams)]), [
		["/api/sessions/session/messages/turn-page", { turnCount: "3", beforeEntryId: "u+1" }],
		["/api/sessions/session/messages/turn-page", { before: "21", turnCount: "2" }],
		["/api/sessions/session/messages/page", { before: "15", pageSize: "5" }],
	]);
});
