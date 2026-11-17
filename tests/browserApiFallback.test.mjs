import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadBrowserApiModule() {
	const source = readFileSync("src/renderer/src/browserApi.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const previewProjects = [{ id: "preview-project", name: "Preview" }];
	const sandbox = {
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
	const { createBrowserApi } = loadBrowserApiModule();
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async () => ({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => {
			throw new Error("Unexpected token <");
		},
	});

	const api = createBrowserApi();

	try {
		const projects = await api.projects.list();

		assert.deepEqual(projects, [{ id: "preview-project", name: "Preview" }]);
	} finally {
		globalThis.fetch = previousFetch;
	}
});
