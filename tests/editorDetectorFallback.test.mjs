import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

function loadEditorDetector(spawn) {
	const source = readFileSync("src/main/editors/EditorDetector.ts", "utf8");
	const compiled = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
	const module = { exports: {} };
	const sandbox = {
		module,
		exports: module.exports,
		process,
		console: { log: () => {}, error: () => {} },
		require(id) {
			if (id === "node:child_process") return { spawn };
			if (id === "../../shared/types") {
				return {
					SUPPORTED_EXTERNAL_EDITORS: [],
					createDefaultExternalEditorSettings: () => ({}),
				};
			}
			return require(id);
		},
	};
	vm.runInNewContext(compiled, sandbox, { filename: "EditorDetector.cjs" });
	return module.exports;
}

function createFailingChild() {
	let errorHandler;
	let notifyErrorHandlerReady;
	const errorHandlerReady = new Promise((resolve) => {
		notifyErrorHandlerReady = resolve;
	});
	return {
		pid: undefined,
		once(event, handler) {
			if (event === "error") {
				errorHandler = handler;
				notifyErrorHandlerReady();
			}
			return this;
		},
		unref() {},
		async emitError(error) {
			await errorHandlerReady;
			assert.ok(errorHandler, "spawn error handler must be registered");
			// EventEmitter ignores async listener return values. Awaiting it here prevents an
			// intentional red-phase rejection from becoming test-process noise.
			await errorHandler(error);
		},
	};
}

test("openProjectInEditor rejects the original spawn error when openPath fallback rejects", async () => {
	const child = createFailingChild();
	const { openProjectInEditor } = loadEditorDetector(() => child);
	const spawnError = new Error("editor executable missing");
	const openPromise = openProjectInEditor(
		{ id: "vscode", name: "VS Code", command: process.execPath, args: [] },
		"C:\\projects\\demo",
		async () => {
			throw new Error("platform shell failed");
		},
	);

	await child.emitError(spawnError);
	await assert.rejects(openPromise, (error) => error === spawnError);
});
